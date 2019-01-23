import { MyReview, getReviews, getGithubReviewsUrl, getGithubPRUrl } from './github';

import { app, shell, Menu } from 'electron';
import path from 'path';
import 'moment-business-time';
import moment from 'moment';
import autoLaunch from 'auto-launch';
import _ from 'lodash';

const POLL_INTERVAL_MS = moment.duration(30, 's').asMilliseconds();
const MAX_BADNESS_SCORE = 7;

const imagesDirPath = path.join(__dirname, '..', 'images');
const scoreImagesDirPath = path.join(imagesDirPath, 'score');

/**
 * Used to determine if review count goes up (so that we can bounce icon in the dock).
 */
let pendingReviewsCount: number | null = null;

/**
 * Sets the dock icon image and badge.
 */
async function updateIcon(myReviews: MyReview[]) {
  app.setBadgeCount(myReviews.length);
  const badnessLevel = Math.min(calculateBadnessScore(myReviews), MAX_BADNESS_SCORE);
  app.dock.setIcon(path.join(scoreImagesDirPath, `score_${badnessLevel}.png`));
}

function getLastReviewUpdateTime(review: MyReview) {
  const { reviewRequestedAt, myLastCommentAt } = review;
  if (myLastCommentAt && myLastCommentAt > reviewRequestedAt) {
    return myLastCommentAt;
  }
  return reviewRequestedAt;
}

/**
 * Returns a score (0 - MAX_BADNESS_SCORE) where 0 is best and `MAX_BADNESS_SCORE` means
 * you basically don't review your incoming PRs at all ;)
 *
 */
function calculateBadnessScore(reviews: MyReview[]) {
  const scores = reviews.map(review => {
    const lastUpdatedAt = getLastReviewUpdateTime(review);
    const workHoursSinceLastUpdate = moment().workingDiff(moment(lastUpdatedAt), 'hours');
    console.log('work hours', workHoursSinceLastUpdate);
    return Math.floor(workHoursSinceLastUpdate / 4);
  });
  console.log('scores', scores);
  return _.max(scores) || 0;
}

/**
 * Builds the context menu you see when you right-click the app icon.
 * Shows a list of your incoming PRs with humanized last-update time.
 */
function constructMenu(reviews: MyReview[]) {
  let menuItems: Electron.MenuItemConstructorOptions[];
  if (reviews.length > 0) {
    const reviewsByLastRequestTime = _.sortBy(reviews, r => getLastReviewUpdateTime(r));
    menuItems = [
      {
        label: 'Your pending reviews',
        submenu: reviewsByLastRequestTime.map(review => ({
          label: `${_.truncate(review.title, { length: 60 })} [from ${review.author}] [last updated ${moment(
            getLastReviewUpdateTime(review)
          ).fromNow()}]`,
          click: async () => {
            const url = await getGithubPRUrl(review.number.toString());
            shell.openExternal(url);
          },
        })),
      },
    ];
  } else {
    menuItems = [
      {
        label: 'Your review queue is empty. Good on ya! 🙌',
        enabled: false,
      },
    ];
  }
  return Menu.buildFromTemplate(menuItems);
}

async function updateApp() {
  try {
    const { myReviews } = await getReviews();
    await updateIcon(myReviews);
    app.dock.setMenu(constructMenu(myReviews));
    if (pendingReviewsCount != null && pendingReviewsCount < myReviews.length) {
      app.dock.bounce();
    }
    pendingReviewsCount = myReviews.length;
  } catch (e) {
    console.error(e);
  }
}

// Initially set the icon to a progress indicator while we're loading data from GH.
app.dock.setIcon(path.join(imagesDirPath, 'spinner.png'));

app.on('ready', async () => {
  app.setBadgeCount(0);
  // Start polling and updating the icon.
  await updateApp();
  setInterval(async () => await updateApp(), POLL_INTERVAL_MS);
});

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async function() {
  // On icon click open your incoming PRs page on GitHub.
  shell.openExternal(await getGithubReviewsUrl());
});

// Set up auto launch on system start.
const autoLauncher = new autoLaunch({ name: 'CanvaBoy' });
autoLauncher.enable();
