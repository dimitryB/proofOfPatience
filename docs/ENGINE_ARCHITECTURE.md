# POP presentation architecture

Everything below is a contract. `lib/render/types.ts` is the single source of
truth for shapes; this document explains intent, ownership and quality bars.

## Art direction — cinematic broadcast realism

A late-night television studio shot on a cine lens.

- **Light** is motivated. Every bright pixel has a source in the set: overhead
  key rigs, a practical desk lamp, the LED wall behind the host, the audience
  monitors. No unmotivated glow.
- **Materials** read as real: brushed aluminium trim, matte acoustic foam,
  polished floor with anisotropic reflections, glass caller cards with genuine
  Fresnel edge brightening and refraction of what is behind them.
- **Atmosphere** carries depth: haze catches the key lights as volumetric
  shafts, dust drifts, the background sits behind a shallow depth-of-field.
- **Lens** is a character: bloom blooms only on genuine highlights, chromatic
  aberration grows toward the frame edge, fine grain sits over everything,
  barrel distortion is subtle, a dirty-lens layer catches flares.
- **Colour**: Hemi orange `#ff4600` is the only saturated hue. Everything else
  is warm neutral, deep charcoal `#080604`, aluminium `#8d8781`, bone `#efe7e0`.
  Never introduce a second saturated hue; danger reads as orange pushed hotter
  toward `#ff2a00` plus contrast, never as red-versus-green.
- **Type** is broadcast graphics: tight tracking, high weight, lower-third slabs,
  numerals that tick like hardware counters.

Reference bar: the menu and HUD layer of a modern AAA title. If a frame would
not survive being posted as a launch screenshot, it is not done.

## Module ownership

Each file has exactly one owner. Never edit a file you do not own; never edit
`lib/render/types.ts` at all.

| File | Exports | Owns |
| --- | --- | --- |
| `lib/engine/core.ts` | `createRng`, `createNoise`, `createSpring`, `createCamera`, `createClock`, `lerp`, `clamp`, `clamp01`, `smoothstep`, `smootherstep`, `damp`, `invLerp`, `remap`, `ease`, `vec`, `parseColor`, `mixColor`, `withAlpha`, `shade` | Determinism, easing, springs, camera, time authority, colour maths |
| `lib/engine/textures.ts` | `createTextureBakery` | Every procedural texture and sprite |
| `lib/engine/postfx.ts` | `createPostChain`, `defaultPostParams` | The WebGL2 post-processing chain |
| `lib/engine/audio.ts` | `createAudioEngine` | Synthesised SFX and adaptive score |
| `lib/engine/fx.ts` | `createParticleSystem`, `createRibbon`, `createRope` | Particles, trails, verlet ropes |
| `lib/render/studio.ts` | `createStudio` | Set, lighting, crowd, haze, floor |
| `lib/render/question.ts` | `createQuestionRenderer` | Caller cards and their materials |
| `lib/render/desk.ts` | `createDeskRenderer` | Host desk, mic, aim guide, recoil |
| `lib/render/effects.ts` | `createEffectsRenderer` | Shots, impacts, shockwaves, popups |
| `lib/render/overlay.ts` | `createOverlayRenderer` | In-canvas broadcast graphics |

## Hard rules

1. **No new npm dependencies.** Everything is hand-written and must run on a
   Cloudflare Worker build with no Node built-ins.
2. **No `Math.random`** anywhere in render or simulation code. Use the injected
   `Rng`. Frame output must be reproducible for screenshot diffing.
3. **No DOM access** outside canvas creation. No `window` reads at module scope
   — the app server-renders, so all browser access happens lazily inside
   functions.
4. **Everything is baked once.** Gradients, patterns and sprites are created at
   init or first use and cached. Nothing allocates per frame in a hot loop; no
   `createLinearGradient` inside a per-entity loop.
5. **Budget: 60fps at 1000×620 logical, on integrated graphics.** Particle
   systems are pooled with a hard cap. Respect `scene.quality`.
6. **Respect `scene.reducedMotion`**: no shake, no glitch, no flashing above
   3 Hz, reduce particles by ~70 %, keep the composition identical.
7. **Typed strictly.** No `any`. The project compiles with `tsc --noEmit`.
8. Keep the QA bridge in `app/page.tsx` working: `window.__popGame` exposes
   `game()`, `start()`, `fire()`, `simulate(seconds)`, `aimNorm(nx, ny)`,
   `aimAtTarget()` whenever `window.__POP_QA__` is true.

## Render order

The scene is drawn into an offscreen 2D canvas, then handed to the post chain,
which presents into the visible canvas.

```
studio.drawBackground      set, LED wall, crowd, key lights, haze, floor
particles.draw("behind")   dust, smoke behind entities
desk.drawAimGuide          reticle and trajectory
question.drawShadows       contact shadows on the floor plane
question.draw              caller cards
effects.drawShots          letters in flight with ribbon trails
desk.draw                  host desk, mic, muzzle flash
particles.draw("front")    sparks, debris, embers
effects.drawOverlayEffects shockwaves, score popups
studio.drawForeground      volumetric shafts, lens dirt, foreground haze
overlay.draw               broadcast graphics: lower third, ticker, timer
--> postfx.render          bloom, CA, grade, vignette, grain, scanlines
```

## Quality bar per module

- **studio**: the set must have believable depth — at least five parallax
  planes, real light falloff, a crowd that reads as people not blobs, haze
  volumes that respond to the key lights, and a floor with a blurred reflection
  of the cards above it.
- **question**: cards are physical objects — glass panel over a dark substrate,
  bevelled aluminium frame, per-letter answer slots that fill with a satisfying
  mechanical action, a caller avatar, and a state language (idle → targeted →
  hit → answered → falling) that is unmistakable at a glance.
- **desk**: the host desk is a real object with a mic on a boom, a cable
  simulated as a verlet rope, recoil that translates and rotates, and a muzzle
  flash that lights the desk surface and the floor around it.
- **effects**: every impact needs at least four layers — flash, sparks, ring,
  debris — plus hit-stop, camera punch and a score popup with its own motion
  curve. Nothing may look like a coloured square.
- **overlay**: broadcast furniture that would pass on real television: an
  animated lower third, a running ticker of community chatter, a clock that
  reads like hardware, and an announcement system with typographic hierarchy.
