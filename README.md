# Karelia Labs for Solar2D

Tools and plugins for [Solar2D](https://solar2d.com) developers.

| Product | What it does |
|---|---|
| [Karelia Consent](consent/README.md) | GDPR, Google UMP and ATT in one call, with a privacy settings button and mediation forwarding. |
| [Karelia Web Kit](webkit/README.md) | One Lua API for Poki, CrazyGames, GameDistribution, Google H5 Games Ads and Wavedash, plus a patcher for strict hosts. |
| [Karelia Ship Check](shipcheck/README.md) | Will Google Play and the App Store accept your Solar2D build? Lite is free and runs below; Pro adds every store rule. |

**Try Ship Check Lite now:** https://karelialabs.com/shipcheck/lite/index.html checks the 16 KB page rule and 64-bit libraries of an APK or AAB, and names the plugin behind each problem. It runs in your browser; the file is never uploaded. Background and fixes: [Solar2D and Google Play's 16 KB page size rule](https://karelialabs.com/guides/solar2d-android-16kb-page-size).

**Offline and in CI:** download Ship Check Lite free from [Solar2D Plugins](https://www.solar2dplugins.com/assets/karelia-ship-check-lite). Open `app/index.html` without a network, or run `node app/cli.js MyGame.aab` (Node 18+) in CI; it exits with code 1 when something must be fixed.

Support: [SUPPORT.md](SUPPORT.md) · support@karelialabs.atlassian.net · More tools: [karelialabs.com/tools](https://karelialabs.com/tools)

This repository holds the documentation and the free Ship Check Lite. The paid products are sold on the Solar2D marketplaces. See LICENSE.txt.
