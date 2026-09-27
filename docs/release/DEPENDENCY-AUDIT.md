# 0.1.5 dependency reachability review

Date: 2026-09-27. Scope: the five previously reported production-tree findings,
not a full Electron/Python/application security certification.

| Package | Installed version | Dependency path | Relevant exposure |
| --- | --- | --- | --- |
| browserslist | 4.28.2 | plugin-react -> Babel -> helper-compilation-targets | Build target queries and custom stats |
| baseline-browser-mapping | 2.10.37 | browserslist | Invalid build target input/process termination |
| esbuild | 0.27.7 | vite | Windows development server file serving |
| postcss | 8.5.15 | vite | CSS processing/source-map input |
| nanoid | 3.3.12 | vite -> postcss | Generator calls with invalid size parameters |

## Confirmed

All five packages exist in installed app.asar. Vite and plugin-react are listed
under dependencies, so electron-builder includes their transitive dependencies.
The first exploratory archive filter used the wrong Windows path separator;
its zero counts were rejected and replaced by direct archive entry inspection.

Searches of ui/electron and ui/src found no direct imports/calls of these five
packages. main.js normally loads dist/index.html. It does not normally start a
Vite/esbuild server or compile user chat as CSS/build input. Tools containing
build/test entrypoints are not evidence those paths run during ordinary coaching.

Therefore no demonstrated exploit path from normal lobby/Match chat to these
five affected functions was found. This is NOT proof the installer is globally
safe, and the dependencies' vulnerable versions remain present.

## Boundaries and follow-up

VITE_DEV_SERVER_URL is still honored without an isPackaged guard. The finding
above describes the default launch, not launches with a custom developer URL.
Developer builds process repository configuration and source files, so do not
interpret this review as approval to build untrusted input.

Recommended targeted follow-up: move Vite/plugin-react to devDependencies and
verify the resulting package contents; separately update affected build-chain
versions within compatible ranges, then run renderer build and installed-app
gates. No forced upgrade was performed in this review. The installed EXE and
its dependency versions were not changed.

Audit reported 3 high, 1 moderate and 1 low for these five package entries;
severity is the advisory rating, not a measured exploit rating for JCC Runtime.
