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

const CONFIG_KEY_GH_API_KEY = 'canvaboy.githubToken';
const CONFIG_KEY_GH_API_KEY_FALLBACK = 'github.apiKey';

const GITHUB_ORG = 'canva';

type GithubPR = {
  number: number;
  title: string;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
  };
  repository_url: string;
};

type DecoratedGithubPR = GithubPR & {
  reviewRequestedAt: Date;
  myLastCommentAt?: Date;
  orgAndRepo: string;
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
  orgAndRepo: string;
};

const store = new Store();

/**
 * Initializes and returns octnode (GitHub API) client and SimpleGit (git) client.
 */
async function getGithubClient() {
  const sg = simpleGit();
  let key = await sg.raw(['config', '--get', '--global', CONFIG_KEY_GH_API_KEY]);
  if (!key) {
    key = await sg.raw(['config', '--get', '--global', CONFIG_KEY_GH_API_KEY_FALLBACK]);
  }
  if (!key) {
    try {
      key = fs.readFileSync(path.join(`${process.env.HOME}`, '.pr-train'), 'utf-8');
    } catch {}
  }
  if (!key) {
    const title = 'GitHub API Key not found';
    const content =
      `Please run "git config --global ${CONFIG_KEY_GH_API_KEY} <Your GH API key>" ` +
      `to enable Canva Boy to access your pull requests data.`;
    dialog.showErrorBox(title, content);
    process.exit(1);
  }
  key = key.trim();
  const client = github.client(key);
  return {
    sg,
    client,
    apiKey: key,
  };
}

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

export async function getReviews(lastReviews: MyReview[]) {
  const { client, apiKey } = await getGithubClient();

  const githubNick = await getGithubNick(client);
  console.log('GitHub nick:', githubNick);

  const ghsearch = client.search();

  const results: [{ items: GithubPR[] }] = await ghsearch.issuesAsync({
    q: `state:open+org:${GITHUB_ORG}+type:pr+review-requested:${githubNick}`,
    sort: 'updated',
    order: 'desc',
  });

  const { items } = results[0];

  const decoratedPrs = await Promise.all(
    items.map(
      async (pr): Promise<DecoratedGithubPR | undefined> => {
        try {
          const lastReview = lastReviews.find(r => r.number === pr.number);
          if (lastReview && lastReview.updatedAt.getTime() === new Date(pr.updated_at).getTime()) {
            console.log(`cache hit for PR: ${pr.number}`);
            return {
              ...pr,
              reviewRequestedAt: lastReview.reviewRequestedAt,
              myLastCommentAt: lastReview.myLastCommentAt,
              orgAndRepo: lastReview.orgAndRepo,
            };
          }
          // Parse GH org and repo that this PR belongs to from the URL in the JSON reply.
          const orgRepoMatch = pr.repository_url.match(/.*\/([^\/]+\/[^\/]+)$/);
          const orgAndRepo = orgRepoMatch && orgRepoMatch[1];
          if (!orgAndRepo) {
            // Something weird has happened, PR doesn't have valid `repository_url` => skip it.
            console.log(`ERROR, ${pr.number} has invalid repository_url: ${pr.repository_url}`);
            return undefined;
          }
          const ghpr = client.pr(orgAndRepo, pr.number);
          const ghissue = client.issue(orgAndRepo, pr.number);

          const [activity, prComments, issueComments] = await Promise.all([
            fetchActivityForPr(pr.number, orgAndRepo, apiKey),
            ghpr.commentsAsync() as Promise<[GithubComment[]]>,
            ghissue.commentsAsync() as Promise<[GithubComment[]]>,
          ]);
          const comments = [...prComments[0], ...issueComments[0]];
          if (pr.number === 40848) {
            console.log(comments);
          }

          const lastReviewRequestForUser = _.sortBy(activity, ['created_at'])
            .reverse()
            .find(
              act =>
                act.event === 'review_requested' &&
                act.requested_reviewer.login.toLowerCase() === githubNick.toLowerCase()
            );

          // Get my comments only and sort them so we can get the most recent one.
          const myCommentsUpdatedAt = comments
            .filter(c => c.user.login.toLowerCase() === githubNick.toLowerCase())
            .map(c => new Date(c.updated_at).getTime())
            .sort()
            .reverse();

          if (pr.number === 40848) {
            console.log('my last comment', myCommentsUpdatedAt);
          }

          return {
            ...pr,
            reviewRequestedAt: new Date(lastReviewRequestForUser ? lastReviewRequestForUser.created_at : 0),
            myLastCommentAt: myCommentsUpdatedAt.length > 0 ? new Date(myCommentsUpdatedAt[0]) : undefined,
            orgAndRepo,
          };
        } catch (e) {
          console.error('ERROR', e);
          return undefined;
        }
      }
    )
  );

  // console.log(decoratedPrs.map(pr => [pr.myLastCommentAt, pr.reviewRequestedAt]));

  // Map to a format that's easier to work with (also: camelCase FTW).
  const myReviews = decoratedPrs
    .filter((pr): pr is DecoratedGithubPR => !!pr)
    .map(item => ({
      title: item.title,
      createdAt: moment(item.created_at).toDate(),
      updatedAt: moment(item.updated_at).toDate(),
      reviewRequestedAt: item.reviewRequestedAt,
      myLastCommentAt: item.myLastCommentAt,
      number: item.number,
      author: item.user.login,
      orgAndRepo: item.orgAndRepo,
    }));

  return {
    myReviews,
  };
}

/**
 * Returns JSON result of querying the GitHub activity API
 * @param prId
 * @param orgAndRepo
 * @param accessToken
 */
async function fetchActivityForPr(prId: number, orgAndRepo: string, accessToken: string): Promise<IssueActivity[]> {
  const res = await fetch(
    `https://api.github.com/repos/${orgAndRepo}/issues/${prId}/events?access_token=${accessToken}&per_page=100`
  );
  const json = await res.json();
  return json;
}

/**
 * Returns a URL pointing to GitHub page with all my incoming PRs for GITHUB_ORG.
 */
export async function getGithubReviewsUrl() {
  const { client } = await getGithubClient();
  const githubNick = await getGithubNick(client);
  return `https://github.com/search?q=review-requested%3A${githubNick}+is%3Apr+is%3Aopen+org%3A${GITHUB_ORG}&type=Issues`;
}

/**
 * Returns a URL pointing to PR identified by `prNumber`.
 */
export function getGithubPRUrl(prNumber: string, orgAndRepo: string) {
  return `https://github.com/${orgAndRepo}/pull/${prNumber}`;
}
