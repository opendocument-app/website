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
} as const;

/** What the download buttons point at. Both platforms show the free edition. */
export const primary = {
  android: stores.android.free,
  ios: stores.ios.free,
  fdroid: stores.fdroid,
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

export const contact = {
  support: 'mailto:support@opendocument.app',
  /* Hosted here rather than on the author's blog, which is where the old site
     pointed. The wording is carried over unchanged; see `pages/privacy.astro`. */
  privacy: '/privacy',
} as const;
