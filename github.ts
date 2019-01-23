// @ts-check
import simpleGit, { SimpleGit } from 'simple-git/promise';
import github from 'octonode';
import moment from 'moment';
import _ from 'lodash';
import Store from 'electron-store';
import fs from 'fs';
import path from 'path';
import { dialog } from 'electron';
import fetch from 'isomorphic-fetch';

const CONFIG_KEY_ORG_REPO = 'canvaboy.orgRepo';
const CONFIG_KEY_GH_API_KEY = 'github.apiKey';

const store = new Store();

async function getOrgAndRepo(sg: simpleGit.SimpleGit): Promise<string> {
  const orgAndRepo = await sg.raw(['config', '--get', '--global', CONFIG_KEY_ORG_REPO]);
  return (orgAndRepo || 'Canva/canva').trim();
}

/**
 * Initializes and returns octnode (GitHub API) client and SimpleGit (git) client.
 */
async function getGithubClient() {
  const sg = simpleGit();
  let key = await sg.raw(['config', '--get', '--global', CONFIG_KEY_GH_API_KEY]);
  if (!key) {
    try {
      key = fs.readFileSync(path.join(`${process.env.HOME}`, '.pr-train'), 'utf-8');
    } catch {
      const title = 'GitHub API Key not found';
      const content =
        `Please run "git config --global ${CONFIG_KEY_GH_API_KEY} <Your GH API key>" ` +
        `to enable Canva Boy to access your pull requests data.`;
      dialog.showErrorBox(title, content);
      process.exit(1);
    }
  }
  key = key.trim();
  const client = github.client(key);
  return {
    sg,
    client,
    apiKey: key,
  };
}

type GithubPR = {
  number: number;
  title: string;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
  };
};

type DecoratedGithubPR = GithubPR & {
  reviewRequestedAt: Date;
  myLastCommentAt?: Date;
};

type GithubComment = {
  user: {
    login: string;
  };
  updated_at: string;
};

type IssueActivity = {
  event: string;
  requested_reviewer: {
    login: string;
  };
  created_at: string;
};

export type MyReview = {
  // GitHub PR identifier.
  number: number;
  title: string;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  reviewRequestedAt: Date;
  myLastCommentAt?: Date;
};

/**
 * Returns your github nick. To make things a bit snappier, we store this in electron-store
 * so that we don't need to look it up on startup (we assume it won't change).
 */
async function getGithubNick(client: any) {
  let githubNick = store.get('github_nick');
  if (!githubNick) {
    const ghme = client.me();
    const myGithubInfo = (await ghme.infoAsync())[0];
    githubNick = myGithubInfo.login;
    store.set('github_nick', githubNick);
  }

  return githubNick;
}

export async function getReviews() {
  const { client, sg, apiKey } = await getGithubClient();

  const githubNick = await getGithubNick(client);
  console.log('GitHub nick:', githubNick);

  const orgAndRepo = await getOrgAndRepo(sg);
  const ghsearch = client.search();

  const results: [{ items: GithubPR[] }] = await ghsearch.issuesAsync({
    q: `state:open+repo:${orgAndRepo}+type:pr+review-requested:${githubNick}`,
    sort: 'updated',
    order: 'desc',
  });

  const { items } = results[0];

  const decoratedPrs = await Promise.all(
    items.map(
      async (pr): Promise<DecoratedGithubPR> => {
        const activity = await fetchActivityForPr(pr.number, orgAndRepo, apiKey);
        const lastReviewRequestForUser = _.sortBy(activity, ['created_at'])
          .reverse()
          .find(
            act =>
              act.event === 'review_requested' &&
              act.requested_reviewer.login.toLowerCase() === githubNick.toLowerCase()
          );

        // Fetch the GitHub PR data.
        const ghpr = client.pr(orgAndRepo, pr.number);
        const comments: [GithubComment[]] = await ghpr.commentsAsync();
        // Get my comments only and sort them so we can get the most recent one.
        const myCommentsUpdatedAt = comments[0]
          .filter(c => c.user.login.toLowerCase() === githubNick.toLowerCase())
          .map(c => new Date(c.updated_at));
        myCommentsUpdatedAt.sort();

        return {
          ...pr,
          reviewRequestedAt: new Date(lastReviewRequestForUser ? lastReviewRequestForUser.created_at : 0),
          myLastCommentAt: myCommentsUpdatedAt.length > 0 ? new Date(myCommentsUpdatedAt[0]) : undefined,
        };
      }
    )
  );

  console.log(decoratedPrs.map(pr => [pr.myLastCommentAt, pr.reviewRequestedAt]));

  const myReviews = decoratedPrs.map(item => ({
    title: item.title,
    createdAt: moment(item.created_at).toDate(),
    updatedAt: moment(item.updated_at).toDate(),
    reviewRequestedAt: item.reviewRequestedAt,
    myLastCommentAt: item.myLastCommentAt,
    number: item.number,
    author: item.user.login,
  }));

  return {
    myReviews,
  };
}

async function fetchActivityForPr(prId: number, orgAndRepo: string, accessToken: string): Promise<IssueActivity[]> {
  const res = await fetch(
    `https://api.github.com/repos/${orgAndRepo}/issues/${prId}/events?access_token=${accessToken}&per_page=100`
  );
  const json = await res.json();
  return json;
}

/**
 * Returns a URL pointing to GitHub page with all my incoming PRs.
 */
export async function getGithubReviewsUrl() {
  const { client, sg } = await getGithubClient();
  const githubNick = await getGithubNick(client);
  const orgAndRepo = await getOrgAndRepo(sg);
  return `https://github.com/${orgAndRepo}/pulls?q=is%3Apr+is%3Aopen+review-requested%3A${githubNick}+sort%3Aupdated-desc`;
}

/**
 * Returns a URL pointing to PR identified by `prNumber`.
 */
export async function getGithubPRUrl(prNumber: string) {
  const { sg } = await getGithubClient();
  const orgAndRepo = await getOrgAndRepo(sg);
  return `https://github.com/${orgAndRepo}/pull/${prNumber}`;
}
