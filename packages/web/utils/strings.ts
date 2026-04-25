/**
 * Centralized viewer-facing strings.
 *
 * All user-visible copy that appears on the homepage, watch page, account page,
 * header, and other public surfaces lives here. This makes it straightforward
 * to customise or translate the project without hunting through SFCs.
 *
 * Admin-only copy (dashboard labels, toast messages) is intentionally excluded
 * — those strings are tightly coupled to admin UI and rarely translated.
 */

const strings = {
  // ── Site-wide ──────────────────────────────────────────────────────────────
  siteName: 'Video Monetization Platform',
  siteNameShort: 'VMP',
  siteDescription: 'Premium video content platform',

  // ── Header ─────────────────────────────────────────────────────────────────
  signIn: 'Sign in',
  signOut: 'Sign out',
  accountMenu: 'Open account menu',
  signedInAs: 'Signed in as',
  adminConsole: 'Admin console',
  account: 'Account',
  enableNotifications: 'Enable notifications',
  disableNotifications: 'Disable notifications',
  notificationsBlocked: 'Notifications blocked by browser',
  notificationsOn: 'Notifications on — click to disable',
  notificationsClickEnable: 'Click to enable new video notifications',
  notificationsEnabled: 'Notifications enabled.',
  notificationsTurnedOff: 'Notifications turned off.',

  // ── Homepage ───────────────────────────────────────────────────────────────
  heroTitleDefault: 'Discover Premium Video Content',
  heroSubtitleDefault: 'Watch free previews or unlock full access with a premium subscription',
  loadingVideos: 'Loading videos...',
  errorLoadingVideos: 'Error Loading Videos',
  noVideosTitle: 'No Videos Yet',
  noVideosSubtitle: 'Check back soon for new content',
  recentVideos: 'Recent videos',
  allUncategorized: 'All uncategorized videos',
  availableVideos: 'Available Videos',
  moreInCategory: (n: number) => `+${n} more in this category`,
  categoryMoreLink: 'More →',

  // ── Watch page ─────────────────────────────────────────────────────────────
  loadingVideo: 'Loading video...',
  noDescription: 'No description available.',
  previewMode: 'Preview Mode',
  upgradeToWatch: 'Upgrade to watch full video',
  premiumAccess: 'Premium Access',
  /** Shown when the full video is unlocked for anonymous viewers (preview lock = full duration). */
  freeToWatch: 'Free to watch',
  previewOnly: (duration: string) => `Preview Only (${duration})`,
  upNext: 'Up Next',
  videoBuffering: 'Video is buffering',
  playVideo: 'Play video',
  videoPlaybackError: 'Video playback error. The HLS stream could not be loaded.',
  livestreamUnavailable: 'Livestream feed unavailable',
  livestreamUnavailableDetail: 'The stream is not currently connected. Attach a recording or update the livestream playback URL in admin.',

  // ── Rate limit ─────────────────────────────────────────────────────────────
  rateLimitTitle: 'Free preview limit reached',
  rateLimitMessage: (current: number, limit: number) =>
    `You've watched ${current} of ${limit} free previews this hour. Sign in for unlimited previews — it's free.`,
  rateLimitWait: (time: string) => `Or wait ${time} for your limit to reset.`,

  // ── Account page ───────────────────────────────────────────────────────────
  yourAccount: 'Your account',
  currentPlan: 'Current plan',
  manageSubscription: 'Manage subscription',
  subscribedWelcome: "You're now subscribed!",
  subscribedWelcomeDetail: 'Welcome to VMP Premium. Enjoy unlimited access to all content.',
  renewsOn: 'Renews on',
  accessUntil: 'Access until',

  // ── PWA ────────────────────────────────────────────────────────────────────
  pwaInstallPrompt: 'Install the app for quick access to your videos.',
  pwaInstall: 'Install',

  // ── Premium badge ──────────────────────────────────────────────────────────
  premiumBadge: 'PREMIUM',
  proBadge: 'PRO',

  // ── Misc ───────────────────────────────────────────────────────────────────
  backToHomepage: '← Back to homepage',
  error: 'Error',
}

export default strings
