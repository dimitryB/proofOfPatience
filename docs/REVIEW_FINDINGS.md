# AAA design review — round 1 findings

Four independent hostile reviewers graded the build against a shipped-AAA bar.
Verdicts: **REJECT 44, REJECT 41, REJECT 42, REJECT 52** (out of 100).

Findings below are as recorded. Some problem statements are truncated at the
point they were captured; treat each as a pointer and re-derive the detail from
the code and a fresh capture before changing anything. Where a finding is wrong,
say so with evidence rather than damaging the build to satisfy it.

## Set, lighting, grade — `studio.ts` / `postfx.ts` / `scene.ts` / `textures.ts`

- **CRITICAL — scene.ts** The grade has collapsed into a single global orange
  tint and there is no neutral material left in the set. On frame 03, 92.5 % of
  visible pixels are saturated (sat > 0.12) and 0.8 % are neutral.
- **CRITICAL — postfx.ts** POP OFF is a uniform full-frame additive white-out
  with no origin and no falloff. `postfx.ts` does
  `color += uFlashColor * (uFlashAmount * 4.0)` and `scene.ts` sets
  `flashChannel = 1` on POP OFF. An ultimate needs an origin, a travelling
  front and a falloff.
- **CRITICAL — studio.ts** Victory and defeat are the same lighting state, and
  both are darker than ordinary gameplay. Measured on identical stage regions,
  win/play and lose/play ratios: truss 18.26 / 17.48 / 29.43 (~0.6×).
- **MAJOR — studio.ts** No depth of field, and the sharpness ordering is
  inverted: the deepest plane is the hardest-edged thing in frame. Laplacian
  variance on 03: truss at (200,20)-(900,70) = 805, far above the near planes.
- **MAJOR — studio.ts** Nothing in the set is lit by anything else — no bounce,
  no cast shadows, no specular on any metal. The lit par can at (185,143) reads
  208 luminance at its lens and throws zero bounce onto the truss around it.
- **MAJOR — studio.ts** The volumetric shafts are flat, hard-edged triangles
  that land nowhere. Uniform internal density, no turbulence, hard edges, and a
  single fixture emits two discrete edge planes rather than a cone.
- **MAJOR — scene.ts** The set does not react to pressure. Between the calmest
  gameplay frame (03, one caller) and max density (08, seven callers) the truss
  band changes by +0.1 luminance.
- **MAJOR — scene.ts** The attract screen throws the entire set away. Comparing
  identical regions in 02 against 03: the desk survives at 6.1 % of its gameplay
  brightness, the truss at 13.3 %, the crowd at 35.9 %.
- **MAJOR — postfx.ts** The required-letter badge on every card carries a hard,
  saturated cyan fringe on its left edge and a yellow fringe on its right —
  unmistakable at 500 % on 06 and 08, visible at 1:1. Chromatic aberration is
  being applied as a flat per-channel offset rather than a radial one, and it is
  far too strong on high-contrast UI edges.

## Caller cards — `question.ts`

- **CRITICAL** Every single letter hit erases the card. `question.ts:2244-2252`
  fills the whole glass path with `WARM_WHITE` additively at
  `cardAlpha * hit * 0.52` where `hit = exp(-sinceHit/0.075)`. The question
  text, the answer slots and the required-letter badge all disappear at exactly
  the moment the player needs to read them.
- **MAJOR** The cards are UI strokes, not physical objects. The "bevelled
  aluminium frame" is a constant-width, constant-brightness white outline on all
  four sides — no light direction, no Fresnel, no material.
- **MAJOR** Per-card progress — the most important state on a card — is its
  least visible element. The socket bank at `question.ts:479` clamps
  `socketSize` to a 5 px logical minimum.

## Desk, aim, projectiles — `desk.ts`

- **CRITICAL** The aim guide is the brightest object in the entire product and
  it is not light. It runs as a 24–32 px additive bar
  (`globalCompositeOperation = "lighter"`, alpha up to 0.72) from the mic across
  the full height of the picture. Measured on 03: peak rgb(250,248,201) at the
  crowd rail, 13–31 px wide at half maximum.
- **CRITICAL** The aim readout prints two strings into the same pixels and
  truncates a third mid-word. `desk.ts:2728` hard-cuts the label with no
  ellipsis (`target.label.slice(0, 13)`) and `desk.ts:2738` right-aligns a
  LOCK/STBY badge into the same box with no reserved space.
- **MAJOR** You cannot tell aiming from firing, and the projectile has no
  weight. `drawAimGuide` (`desk.ts:2742`) paints the same 24–32 px additive beam
  whether or not a shot is in flight.
- **MAJOR** The desk practical is the one clearly-motivated light in the near
  plane and nothing on the desk responds to it. The lamp at (420,590) is
  visibly on and throws a pool onto the desk, yet the props cast nothing.

## Impacts and spectacle — `effects.ts`

- **CRITICAL** The impact does not happen on the card. In 05 the flash, the beam
  terminus and the spark hairlines all sit ~16 px BELOW the card's lower bevel,
  in empty air.
- **CRITICAL** POP OFF is a shapeless white-out, not an ultimate. 12.1 % of
  pixels above 240 luma and 10.7 % fully achromatic near-white, against
  0.2 % / 0.1 % for a normal impact.
- **CRITICAL** The two money moments erase their own type. In 05 the impact
  flash blows the entire caller card to white — question text, answer slots and
  required-letter badge all gone.
- **MAJOR** The high-combo payoff is not bigger than a normal hit, it is
  smaller. Measured: 18-combo mean luma 48.4 with 1.8 % of pixels above 200;
  05-impact 45.7 with 2.7 % above 200.
- **MAJOR** The failure beat is quieter than a normal hit. 17-land measures
  1.4 % of pixels above 200 luma versus 2.7 % for a routine letter impact.
- **MAJOR** The failure beat's type is the weakest graphic on screen:
  "DROPPED" in bare ~22 px type, no plate, no rule, no underlay, floating over
  the crowd at an arbitrary x that puts it 10 px from the right edge.
- **MAJOR** The POP OFF wordmark and the detonation flash are centred on the
  same point, so the flash eats the middle of the word and only "PO" survives.

## In-canvas broadcast graphics — `overlay.ts`

- **MAJOR** The announcement strap is an opaque slab parked permanently over the
  most dangerous part of the play field (`overlay.ts:2182-2183` pins it to
  `layout.strapX` / `layout.strapBottom = stageY - 5…`). In 18 it overprints the
  targeted caller.
- **MAJOR** Letter-spacing fractures words into false fragments. At 700 % the
  lower third reads "MI DWEEK  WI TH  MAX" and "COMMUNI TY  TAKEOVER" — the
  inter-letter gap inside a word exceeds the inter-word gap.

## Simulation and targeting — `scene.ts` / `pop.ts` / `page.tsx`

- **CRITICAL — scene.ts** The lock reticle lies about what you will hit.
  `pickTarget` (`scene.ts:958`) selects any card with `v.targeted` inside a
  0.62 rad (35.5°) angular window from the aim vector, which is not the same
  rule the projectile obeys.
- **MAJOR — page.tsx** A caller card is guillotined by the top edge of the stage
  in every gameplay frame delivered — eleven of eleven. Cards spawn at
  `y = -46` with `CARD_HALF_HEIGHT = 31`.
- **MAJOR — page.tsx** Cards print over each other at density, which is exactly
  what `separateQuestions` claims to prevent. In 08 "WEN ACTUAL DATE?" overlaps
  "zkPROOF WHITEPAPER?" and hides its leading glyph.
- **MAJOR — pop.ts** Card frame colour encodes question identity on the exact
  axis the game needs for danger and targeting. `lib/pop.ts:71-170` gives each
  of the ten caller kinds its own tint spanning #ffffff and up.
- **MAJOR — scene.ts** The ultimate's readiness is invisible in the play field.
  `scene.ts:1283` sets `deskView.charge = clamp01(1 - frame.cooldown /
  FIRE_COOLDOWN)` — the 60 ms fire cooldown, not the POP meter.

## DOM shell — `globals.css` / components

These were found against a design-system build that a container rollback
destroyed; the shell is being rebuilt. Carry them forward as requirements:

- **CRITICAL** The primary control's label is unreadable: "HOLD TO ANSWER" and
  its "S" chip render in aluminium rgb(141,135,129) on an orange face
  rgb(229,80,25). Nowhere near AA.
- **CRITICAL** Focal hierarchy is inverted: the largest, hottest, brightest
  object on the page is a DOM sidebar button, not the play field.
- **CRITICAL** The game is unplayable on mobile. `.stage-screen canvas` is
  `width:100%` with a fixed `aspect-ratio: 1000/620`, so on a 430 px portrait
  viewport the play field renders at roughly 23 % of the screen.
- **MAJOR** The status bar is not on a grid — four captions in one horizontal
  strap sit on four different baselines (113 / 109 / 116 / 121).
- **MAJOR** QUESTION BACKLOG is the widest cell in the status bar (~35 %) and
  carries no readable value: eight empty slots and nothing else.
- **MAJOR** The pressure gauge cannot be read: unlit pips are #1b1410→#0d0908
  with a 5.5 %-alpha inner hairline on a near-identical plate.
- **MAJOR** The score odometer garbles itself while rolling — a digit sits high
  in its window with its apex clipped flat against the cell's top edge.
- **MAJOR** Terminology and casing diverge across surfaces for the same value
  ("Questions parked" in the rail, "QUESTIONS PARKED" in the canvas).
- **MAJOR** The title screen is centred text on a black rectangle, not a
  designed screen. Attract stage mean luminance 16.9/255 versus 41.3 in play.
