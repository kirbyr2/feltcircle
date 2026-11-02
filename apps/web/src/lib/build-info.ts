// Replaced at build time (see apps/web/build-info.ts); never read at runtime from the network.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

/** The version and short commit of this build (commit is empty when Git metadata was unavailable). */
export const BUILD = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : '',
};
