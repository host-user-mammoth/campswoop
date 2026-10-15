# Screenshot and interaction rig

Headless Chromium (Playwright, software WebGL) for checking the site at real sizes without a browser window.

```sh
cd tools/qa
npm install && npm run install-browsers          # once; Chromium goes into tools/qa/browsers (ignored by git)
node shoot.js --root ../../docs --out out/review --hash watch,map --full-page --scroll --wait-ms 1500
node interact.js --root ../../docs --out out/signup --steps examples/signup-redesign.json --viewports desktop,mobile
node interact.js --root ../../docs --out out/map --steps examples/review-map2.json --hash map --reduced-motion
```

- `--viewports desktop,1280x720,1180x820@2,820x1180@2,mobile,360x740@2` covers desktop, laptop, iPad landscape and portrait, iPhone and a small Android.
- `--scroll` sweeps the page first so the fade-in sections render in full-page shots; `--reduced-motion` stops the globe spinning, which the software renderer needs to capture it.
- `interact.js` mocks the CampSwoop API by default, so test sign-ups never reach production. `--help` on either script lists everything.
