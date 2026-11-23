# People assets: sources and licence

The cyclist and spectator meshes and textures in this folder are derived from **MakeHuman 1.1** assets, which the
MakeHuman project released under the **Creative Commons CC0 1.0 Universal** public domain dedication
(<https://creativecommons.org/publicdomain/zero/1.0/>). The MakeHuman licence statement says the bundled assets
(base mesh, proxies, targets, textures, clothes, rigs, poses) are CC0, and that the project claims nothing over
output made from them. Copyright holders at the time of the CC0 release: Data Collection AB, Joel Palmius,
Jonas Hauquier.

Sources (downloaded at development time; not shipped in raw form):

| What | From | Licence |
|---|---|---|
| hm08 base mesh (`3dobjs/base.obj`), modelling targets (`targets/`: macro, proportions, height, torso, arms and legs, face), default skeleton and weights (`rigs/default.mhskel`, `rigs/default_weights.mhw`) | <https://github.com/makehumancommunity/makehuman> (`makehuman/data`; see `LICENSE.md` and `LICENSE.ASSETS.md` there) | CC0 1.0 |
| Proxy meshes (`male1591`, `female1605`, `proxy741`), skins (young caucasian / asian / african male, young caucasian female, old caucasian male), hair (`short01`-`short04`, `ponytail01`, `long01`, `bob02`, `afro01`), eyes (`low-poly`, `brown`), clothes (`male_casualsuit02`-`06`, `male_worksuit01`, `female_casualsuit01`/`02`, `female_elegantsuit01`, `female_sportsuit01`, `fedora01`, `shoes01`-`05`) | MakeHuman system asset pack, <http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip> (every entry in its `packs/makehuman_system_assets.json` is marked `"license": "CC0"`, author `makehuman_system`) | CC0 1.0 |

Files here and how they were made (all reproducible with `scripts/people/`; see the header of
`build-people.mjs`):

- `rider.bin`: two rider bodies (a young athletic man and woman) shaped with MakeHuman targets and posed on the
  bike with the default skeleton and weights, re-weighted to the game's 20-bone skeleton, with three face-shape
  morph targets; the male1591 / female1605 proxies as distant bodies; short02 / ponytail01 hair trimmed to
  what shows under a helmet; plus the helmets, sunglasses and shoes, which are original geometry made by
  `gear.mjs` and `shells.mjs` (no third-party content).
- `skin-light.jpg`, `skin-mid.jpg`, `skin-dark.jpg`, `hair-short.png`, `hair-ponytail.png`: MakeHuman textures
  downscaled (`textures.py`).
- `crowd.bin`, `crowd-atlas.jpg`, `crowd-mask.png`: twelve spectators (bodies, clothes, shoes, hair, eyes and
  hats from the list above, posed twice, simplified) and their texture atlas. The MakeHuman logo and wordmark
  printed on some of the tee textures are painted out (CC0 does not cover trademarks). The caps, beanies, bag,
  phone, flag and the Yorkshire flag's white rose are original.
- `fit.js`, `pack.js`, `assets.js`, `kit.js`: the game's own code.

The kit, logos ("SPINDOWN", the app's own name) and bikes are drawn procedurally by the game's own code. No Zwift
or other game assets, and no Mixamo/Adobe content, are used.
