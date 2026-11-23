# People assets: sources and licence

The cyclist and spectator meshes and textures in this folder are derived from **MakeHuman 1.1** assets, which the
MakeHuman project released under the **Creative Commons CC0 1.0 Universal** public domain dedication
(<https://creativecommons.org/publicdomain/zero/1.0/>). The MakeHuman licence statement says the bundled assets
(base mesh, proxies, targets, textures, clothes, rigs, poses) are CC0, and that the project claims nothing over
output made from them. Copyright holders at the time of the CC0 release: Data Collection AB, Joel Palmius,
Jonas Hauquier.

Sources (downloaded at development time by the build scripts' user; not shipped in raw form):

| What | From | Licence |
|---|---|---|
| hm08 base mesh (`3dobjs/base.obj`), modelling targets (`targets/`), default skeleton and weights (`rigs/default.mhskel`, `rigs/default_weights.mhw`) | <https://github.com/makehumancommunity/makehuman> (`makehuman/data`, `LICENSE.md` and `LICENSE.ASSETS.md` there) | CC0 1.0 |
| Proxy meshes (`male1591`, `proxy741`), skins (`young_caucasian_male`, `young_asian_male`, `young_african_male`), hair (`short02` …), eyebrows (`eyebrow001`), clothes and shoes for spectators | MakeHuman system asset pack, <http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip> (every entry in its `packs/makehuman_system_assets.json` is marked `"license": "CC0"`, author `makehuman_system`) | CC0 1.0 |

Files here and how they were made (all reproducible with `scripts/people/`):

- `rider.bin`: the base mesh shaped with MakeHuman targets (young athletic male), posed on the bike with the
  default skeleton and weights, re-weighted to the game's small skeleton; the male1591 proxy as the distant
  body; eyebrow and short-hair proxies; plus the helmet, sunglasses and shoes, which are original geometry made
  by `scripts/people/gear.mjs` and `shells.mjs` (no third-party content).
- `skin-*.jpg`, `hair-short.png`, `brows.png`: MakeHuman textures downscaled (`scripts/people/textures.py`).
- `crowd.bin` and `crowd-*.jpg` (spectators): MakeHuman bodies, clothes, hair and shoes, posed and merged.

The kit, logos ("SPINDOWN", the app's own name) and bikes are drawn procedurally by the game's own code. No Zwift
or other game assets, and no Mixamo/Adobe content, are used.
