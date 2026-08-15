const {baseConfig} = require('@virmator/spellcheck/configs/cspell.config.base.cjs');

module.exports = {
    ...baseConfig,
    ignorePaths: [
        ...baseConfig.ignorePaths,
    ],
    words: [
        ...baseConfig.words,
        /** Only words appearing in JSON files, which cannot carry inline `cspell:words` comments. */
        'prebuilds',
        'webgl',
        /**
         * Existing project terminology surfaced after cspell's Node requirement forced a cache
         * rebuild.
         */
        'backgrounded',
        'desynced',
        'firstsecond',
        'jank',
        'mistcloak',
        'opencode',
        'refetches',
        'replayable',
        'retints',
        'ribbonlike',
        'travelling',
        'unconfigured',
        'undebounced',
        'Unkeyed',
        'unparked',
        'unparking',
        'unparks',
        'unparseable',
        'untick',
        'unticking',
    ],
};
