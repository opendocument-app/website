/*
  Every outbound URL the page uses, in one place.

  Careful with the two editions: the free app has the full feature set and
  carries advertisement, the paid one is the same app without ads. The store
  identifiers do NOT line up across platforms — `at.tomtasche.reader` is the
  *free* app on Android and the *paid* app on iOS, because the two listings grew
  independently and neither can be renamed without losing its install base.
  Always pick a link by edition and platform, never by the id looking familiar.
*/

export const stores = {
  android: {
    free: 'https://play.google.com/store/apps/details?id=at.tomtasche.reader',
    paid: 'https://play.google.com/store/apps/details?id=at.tomtasche.reader.pro',
  },
  ios: {
    // `at.tomtasche.reader.lite1`
    free: 'https://apps.apple.com/app/id1510195065',
    // `at.tomtasche.reader`
    paid: 'https://apps.apple.com/app/id1452061743',
  },
  fdroid: 'https://f-droid.org/packages/at.tomtasche.reader',
  /*
    Obtainium installs from the GitHub release rather than a store, so this is
    not a listing url but the app's whole configuration, url-encoded: the
    package id, the repository to track, and the name to show. Wrapped in
    apps.obtainium.imranr.dev/redirect so a visitor without Obtainium gets a
    working "get it" page instead of a dead obtainium:// link. The id is the
    foss build's, `at.tomtasche.reader.foss` — a different app from the two
    above, and deliberately so; see the droid repo's readme.
  */
  obtainium:
    'https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22at.tomtasche.reader.foss%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fopendocument-app%2FOpenDocument.droid%22%2C%22author%22%3A%22opendocument-app%22%2C%22name%22%3A%22OpenDocument%20Reader%22%7D',
} as const;

/** What the download buttons point at. Both platforms show the free edition. */
export const primary = {
  android: stores.android.free,
  ios: stores.ios.free,
  fdroid: stores.fdroid,
  obtainium: stores.obtainium,
} as const;

export const packages = {
  npm: 'https://www.npmjs.com/package/@opendocument/odr-core',
  pypi: 'https://pypi.org/project/pyodr/',
  github: 'https://github.com/opendocument-app',
} as const;

export const repos = {
  org: 'https://github.com/opendocument-app',
  core: 'https://github.com/opendocument-app/OpenDocument.core',
  wasm: 'https://github.com/opendocument-app/OpenDocument.core/tree/main/wasm',
  droid: 'https://github.com/opendocument-app/OpenDocument.droid',
  ios: 'https://github.com/opendocument-app/OpenDocument.ios',
  js: 'https://github.com/opendocument-app/OpenDocument.js',
  py: 'https://github.com/opendocument-app/OpenDocument.py',
} as const;

/* The GitHub Sponsors page for the organisation, not for a single repository. */
export const funding = {
  sponsors: 'https://github.com/sponsors/opendocument-app',
} as const;

export const contact = {
  support: 'mailto:support@opendocument.app',
  /* Hosted here rather than on the author's blog, which is where the old site
     pointed. The wording is carried over unchanged; see `pages/privacy.astro`. */
  privacy: '/privacy',
} as const;
