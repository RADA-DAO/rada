# i18n

Typed message keys and interpolation for English (`en`) and Ukrainian (`uk`). Dictionaries live in `locales/`; use `t(locale, key, values)` to pass translated UI strings into shared components. Count messages use locale-aware plural categories through `Intl.PluralRules`.

SPLASH messages live in `en.splash.json` and `uk.splash.json`. The shared
dictionaries compose them under the existing `splash` namespace, keeping
individual locale files below 400 lines.
