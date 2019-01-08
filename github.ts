// @ts-check
import simpleGit from 'simple-git/promise';
import github from 'octonode';
import moment from 'moment';
import _ from 'lodash';
import Store from 'electron-store';
import fs from 'fs';
import path from 'path';
import { dialog } from 'electron';

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
  const client = github.client(key.trim());
  return {
    sg,
    client,
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
  myLastCommentUpdatedAt?: Date;
  lastCommentUpdatedAt?: Date;
};

type GithubComment = {
  user: {
    login: string;
  };
  updated_at: string;
};

export type MyReview = {
  // GitHub PR identifier.
  number: number;
  title: string;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  myLastCommentUpdatedAt?: Date;
  lastCommentUpdatedAt?: Date;
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
  const { client, sg } = await getGithubClient();

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
        // Fetch the GitHub PR data.
        const ghpr = client.pr(orgAndRepo, pr.number);
        const comments: [GithubComment[]] = await ghpr.commentsAsync();

        // Get my comments only and sort them so we can get the most recent one.
        const myCommentsUpdatedAt = comments[0]
          .filter(c => c.user.login.toLowerCase() === githubNick.toLowerCase())
          .map(c => new Date(c.updated_at));
        myCommentsUpdatedAt.sort();

        // Ditto but for _all_ comments (useful if there's no comments made by me yet).
        const allCommentLastUpdatedAts = comments[0].map(c => new Date(c.updated_at));
        allCommentLastUpdatedAts.sort();

        return {
          ...pr,
          myLastCommentUpdatedAt: _.last(myCommentsUpdatedAt),
          lastCommentUpdatedAt: _.last(allCommentLastUpdatedAts),
        };
      }
    )
  );

  const myReviews = decoratedPrs.map(item => ({
    title: item.title,
    createdAt: moment(item.created_at).toDate(),
    updatedAt: moment(item.updated_at).toDate(),
    myLastCommentUpdatedAt: item.myLastCommentUpdatedAt,
    lastCommentUpdatedAt: item.lastCommentUpdatedAt,
    number: item.number,
    author: item.user.login,
  }));

  return {
    myReviews,
  };
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
