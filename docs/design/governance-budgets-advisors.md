# Budgets, Advisers and Approval

Design for three late-game governance features: annual budgets that bodies
propose and then work within, advisers (a "guild of guilds") who answer the
bodies for you, and approval ratings. Written against the uncommitted code in
this worktree (October 2026). File and line references are to that code.

Status: decided (section 11). Steps 0–8 are built; the optional step 9 is not.

---

## 1. Summary

- **Budgets** (Borough and at least 5 sitting bodies). Each autumn, every
  sitting body brings a **budget card**. It lists its running costs, the plans
  it means to pay for, a small reserve, last year's grant and spending, and
  what its dashboard did. You approve it, trim it, keep last year's figure or
  refuse it. Through the year the body pays for its own approved plans (and
  small things) without asking you. Rules, petitions, demands, debates and
  anything it cannot afford still come to you. This replaces today's fixed
  purse shares for those bodies and brings back what "Let them run their own
  affairs" did, now tied to money you granted.
- **Advisers** (City and at least 7 sitting bodies). A bench of up to three
  advisers sits at the town hall. Each covers a group of bodies. Candidates are
  real townsfolk, with backgrounds and beliefs read from the sim: ex-farmer,
  for planning, against the rent cap, cool on the chapel, careful with coin.
  An adviser answers cards in their area by a fixed, explainable scoring of
  their beliefs. Each answer waits one season so you can let it stand or
  change it. Each adviser's card tracks how often you overruled them, how
  their bodies and groups fared, and what they spent. You can dismiss them and
  hire from a new slate.
- **Approval** (shown from Borough, recorded silently from year 0). A yearly
  "how many approve of how you rule" figure for the town, by group, trade,
  wealth, district, centre, age and faith. It is built from data the sim
  already keeps: faction moods, the stances on your rulings, the reactions to
  rule changes, and how many people are thinking of leaving. It comes with a
  history chart and the top reasons it moved. Version 1 only reports; it does
  not feed back into the sim.

Everything is yearly or per card. Nothing new runs per tick over people. The
choices use no random numbers (hash-seeded where variety is needed), so
existing runs replay exactly until a feature switches on. Saves stay at
version 2: every new field is filled with `??=` on restore.

---

## 2. What exists today

### 2.1 Bodies

- **Record.** `createBody` (src/sim/institutions.js:1043) gives
  `{id, kind, name, foundedYear, status, budgetShare, power, patience, metrics,
  delegated, delegateCap, standingOrders, accepted, refused, expired, asker,
  funds, spentThisYear, report, nextDraftMonth}`. The Moot comes from
  `createMoot` (src/sim/state.js:300). `initGovernance` (institutions.js:1054)
  and `normaliseBody` (:1079) fill missing fields on restore. This is the
  existing migration pattern.
- **Catalogue.** `INSTITUTIONS` (institutions.js:95) lists 13 kinds. Each has
  an `axis` lean on the four town traits, a `faction`, a `constituency`, its
  `metrics` (dashboard), its `templates` (what it drafts), and its `rivals`.
  The body-to-template table (costs are era-0 coin, scaled by `costScale`):

  | body | faction | axis | templates (category:cost) |
  |---|---|---|---|
  | moot | – | – | fair, grade-track (work), hall-upgrade 1800, ease-rule, emergency-loan, new-fields 600, cooperative 200, cart-bridge/bridge/bridge-upgrade (works), tax-cut, public-works 900 |
  | agri-council | farmers | industry −1 | seed-exchange 120, new-fields 600, tithe-barn 700, keep-old-fields |
  | trades-guild | crafters | market −.5, innovation −1 | guild-hall 900, quality-mark 80, keep-old-workshops |
  | exchange | merchants | market +1 | exchange-hall 2200, warehouses 900, redevelop-centre |
  | river-authority | labourers | – | bridge, bridge-upgrade, quay, embankment (works), ferry, dredging 500 |
  | school-board | scholars | innovation +1 | school 900, scholarships 300 |
  | parish | clergy | innovation −1 | chapel-upgrade 1400, alms-house 500 |
  | health-board | – | – | infirmary-house 1000, slum-clearance 800, bathhouse 900 |
  | planning | – | authority +1 | pave-lane, square, widen, ring-road, grid, bridge…, turnpike (works), green-space |
  | union | labourers | market −1 | union-hall 600, sick-fund 400, call-strike |
  | watch | – | authority +1 | watch-house 600, tavern-licences |
  | ward | – | authority −.5 | ward-market 120, ward-school 700, ward-rates |
  | arts-society | – | – | fair 250, theatre 1600, carnival 700, green-space |

  Bodies also draft **rule cards** for the policies whose `by` names them
  (`ruleTemplate`, institutions.js:1293; `mootRules` :1565).
- **Founding.** `institutionsMonthly` (:1799) rolls each kind's `when`
  condition and adds a `petitionCard` (:1221). That card offers a small (3%),
  standard (6%) or generous (10%) purse (:1233–1235). `formBody` (:1259) and
  `formWard` (:2004) create the record and call `balancePurses`. A ward
  petitions at `WARD_POP` 600 (:1967).
- **Each year** (`institutionsYearly`, :1849, called from governance
  `year()`, src/sim/governance.js:137): rename, recompute power
  (`computePower` :1123), patience +0.1, spend `RUNNING_SHARE` = 40% of
  `funds` on "clerks, tools, small repairs" through `payBuilders` (:1864–1870),
  check decline and waning, and add a `reportCard` (:1912) if delegated.
- **Drafting.** A body drafts every `DRAFT_EVERY_MONTHS` = 6 (:1610), through
  the decision model (`institution_draft`, src/sim/decisions/kinds.js:303),
  from `eligibleTemplates` (:1334). `eligibleTemplates` ranks by need, applies
  cooldowns (`blocked` :1405) and decline damping (`declineDamp` :1439), and
  is keener with a full chest (`spendMood` :1392). `draftCard` (:1621) builds
  the card. A strong body (power ≥ 0.7) issues a `demand` at most once a decade
  (`cardKind` :1672).

### 2.2 Money

- **Accounts** (src/sim/economy.js:1–12). There are four: treasury, household
  savings, enterprise cash, and body `funds`. `pay` (:102) never lets a
  household, enterprise or body go below zero. `payBuilders` (:121) pays the
  town's builders. Money is conserved; tests check `totalMoney`.
- **Income.** Property tax (ground rent, `groundRent` :608) and income tax
  (`payWages` :440–480). Site tax comes from the land-value-tax rule. Tithe
  goes to the parish or chapel (:672–685). Tolls come yearly
  (governance.js:156).
- **Per-body purses** (the "small yearly budget" today):
  - `fundInstitutions` (economy.js:796) pays each active body
    `budgetShare × (propertyTax + incomeTax)` once a year, capped by the
    treasury.
  - `balancePurses` (institutions.js:1246) scales all `grantShare`s so they
    total at most `PURSE_CAP` = 25% of tax, or 35% with a full chest.
  - A card option `{budget: x}` raises a body's grant (docket.js:535).
  - **Bug found:** the base counts only property and income tax. In the
    year-92 `city` fixture the property tax has been replaced by the
    land-value tax (`siteTax` 10,479) and there is no income tax. So every
    body is paid **0**. The purses read 0–944, and `budget.spend.bodies` is all
    zeros. Today's purses are effectively dead in that kind of town. Budgets
    should not inherit this.
- **Other treasury spending.**
  - Rule upkeep is paid monthly and capped at 40% of free income. Every rule
    is underfunded alike past the cap (governance.js:67–91).
  - Public services: `fundPublic` (economy.js:402).
  - Projects and works are paid by `payer` (`applyEffects`, docket.js:510).
  - Town upkeep spends a quarter of the chest beyond 4 years of spending
    (governance.js:121–135).
  - Receivership: a steward takes the purse below −2 years of spending
    (governance.js:95–116).
- **Yearly snapshot.** `state.budget` (state.js:95) is rebuilt in
  `economyYearly` (economy.js:741–767). `selectBudget` (src/sim/view.js:530)
  turns it into "The town's purse" section on the Town Council page at City
  (`budgetSection`, src/ui/components/late-surfaces.js:6).

### 2.3 Cards

- **Card shape** and `makeCard`: docket.js:1–55.
- **`finishOptions`** (:57) adds Not now and Refuse. It also adds **"Let them
  decide"** (`delegate`) when the body's `funds` cover the cost (:62). This is
  still live, and the card UI shows it as an ordinary option.
- **`addCard`** (:84) runs in this order:
  1. standing orders (`standingOrderFor`, institutions.js:1166);
  2. delegation (`body.delegated && cost ≤ min(funds, delegateCap)` →
     `selfResolve`, :94–97);
  3. subject de-duplication;
  4. rival debates (`mergeDebate` :166);
  5. urgent cards surface at once.
- **Surfacing.** `docketQuarterly` (:229) surfaces up to `SESSION_CAP` per
  quarter and `YEAR_CAP` per year (:28–29). Cards live 24 months.
  `expire` (:280) applies the lapse rule.
- **Rulings.** `rule` (:357) → `settle` (:377) → `applyEffects` (:510). Then:
  - patience +0.03, or −0.05 / −0.15 / −0.3 for not now, refuse, and refuse
    anyway;
  - `moodShift` ±0.04 on the factions in `helps` and `hurts` (:456);
  - `record` (:325) writes `cardHistory` with stances, outcome, place and
    subjects.
- **Self-resolution** already exists: `selfResolve` (:465) picks the first
  affordable option, pays from `body:<id>`, adds a `body.report` line, and
  records outcome `delegated`. `settleByOrder` (:486) does the same for
  standing orders.

### 2.4 Opinion, mood and approval-like data

| data | where | grain | updated |
|---|---|---|---|
| Faction `mood`, `lastMood`, `trend` | src/sim/factions.js:140–165 | 8 factions (+ split parts) | yearly. Target = 0.5 + 0.06·ruleBalance + (wellbeing−60)/200 − 0.3·unrest + looks, smoothed 0.8/0.2 (:147–149) |
| Ruling mood nudges | docket.js:456 | faction by trade | per ruling |
| `card.stances` | scheduler.js:168 (`cardAdded`) | faction per card | on draft (local fallback first, model later) |
| Town opinion of a card | src/sim/opinion.js:75 | town, faction rows | pure read |
| `cardHistory[].stances` | docket.js:337 | faction per ruling (for/against/split) | per ruling, capped 3000 |
| `sliceAnswers[kind]["dim=value"]` with `prev` | scheduler.js:632–669 | slices: trade, wealthBand, district, centre, faction, … | per sweep: `react_to_policy` on each rule change; `household_stay_move` and `crime_charity` yearly; `petition` 6-monthly |
| `disagreement[kind]` | scheduler.js:719 | slice pairs, D × n | per sweep |
| `indicators.tension` | scheduler.js:788, pressures.js:186 | town | per sweep / monthly |
| `indicators.wellbeing` | pressures.js:222 (`wellbeingOf`) | town | monthly |
| `indicatorHistory` | pressures.js:238–251 | town keys, P.*, T.* | yearly, cap 200 |
| `deltaLog` with sources | pressures.js:37 | pressure/trait by source | monthly, then cleared (sources only kept in dev `_traceDeltas`) |
| `answerLog` | scheduler.js:588 | every answer | rolling cap 2000 (0 in the saved fixture) |
| Faction / household story rings | factions.js:168, households.js:34 | 8 entries | on events |

The relevant criteria:

- `react_to_policy`: support / accept / grumble / protest / strike / leave
  (kinds.js:191).
- `household_stay_move`: stay / move_within / emigrate / bring_kin /
  move_to_centre (kinds.js:173).
- `petition`: wait / petition_moot / petition_body / gather / leave
  (kinds.js:210).

`buildSlices` (src/sim/decisions/slices.js:86) already gives every household's
memberships with people counts, cached per tick. One yearly pass over it is
the whole cost of approval by group.

### 2.5 Unlocks and eras

- `ERA` (src/sim/eras.js:11–77):
  - Town: 450 people, 3 bodies.
  - Borough: 1,200 people. `ui: ['debates', 'delegation', 'tensions']`, and
    the arrival text says *"Bodies can run their own affairs."*
  - City: 3,000 people, 6 bodies, 10 rules. `ui: ['budget', …]`.
  - Metropolis: 6,000 people.
  - Each era has year floors and ceilings: Borough 55–80, City 90–115,
    Metropolis 125–140. The chronicle ends at 150.
- `selectUnlocks` (view.js:404–427) is the one place the UI asks what to show.
  It already has `delegation`, `standingOrders` (era 3) and `budget` (era 4).
- The UI turns new unlocks into "New: …" nudges (src/ui/app.js:457–471).
- In the `city` fixture (year 92, era 4, 5,059 people) there are 12 active
  bodies including two wards. "Numerous councils" is real by City.

### 2.6 Leftover delegation and standing-order code

**Now (October 2026):** this code is gone. Budgets and advisers took its place
(step 8; tests/sim-advisers.test.js:206). An old save's `delegated`,
`delegateCap` and `standingOrders` fields are dropped on load (`RETIRED`,
institutions.js:1087). Proposals no longer get a `delegate` option
(docket.js:59–60), and no "Let them decide" text is left in src/ui. What is
left: `reportCard` and `body.report`, now only for bodies on a yearly budget
(institutions.js:1848, 1876); the `delegated` outcome, read from old ruling
histories (approval.js, subjects.js, narrative-facts.js); and the `delegate`
option key and `delegated` act in the narration schema (narrative-prose.js,
narrative-schema.js). The list below is what the audit found before that.

When this was written, all of it was still live in the sim. Only the UI was
removed (HANDOFF.md:103).

- `canDelegate`, `setDelegated`, `setStandingOrder`, `standingOrderFor`
  (institutions.js:1133–1178).
- The delegation and order branches in `addCard` (docket.js:88–97).
- `selfResolve` and `settleByOrder` (:465–507).
- The yearly `reportCard` (institutions.js:1883–1886, 1912).
- The governance actions `setDelegated` and `setStandingOrder`
  (governance.js:266–274), exported from src/sim/index.js and listed in
  src/ui/bridge.js:19.
- View fields `delegated`, `delegateCap`, `canDelegate`, `standingOrders`
  (view.js:212–226). Unlocks `delegation` and `standingOrders`.
- The **`delegate` option** ("Let them decide") on proposals
  (docket.js:57–66, view.js:147). It still reached the player then.
- Stubs in src/ui/dev/stub-sim.js and tests in tests/sim-governance.test.js:176
  and :898.

**Reuse verdict:**

- **Keep and rewire:**
  - `selfResolve`, `body.report` and `reportCard` become the budget path.
  - The `addCard` delegation branch is exactly the hook budgets need. Swap its
    condition for `budgetCovers(state, body, card)`.
  - `standingOrderFor`'s match shape `{category, templateId, policy, action,
    maxCost}` becomes adviser **instructions** in a later step (see 4.9).
- **Retire** once budgets land: the `delegated` / `delegateCap` flags and the
  `setDelegated` action, the `delegate` option, and the
  `delegation` / `standingOrders` unlocks.

### 2.7 People, traits and beliefs

- **Town traits.** `state.traits` holds industry, market, innovation and
  authority, each −1..1, with drift. They show in the UI as Fields↔Industry,
  Commons↔Markets, Old ways↔New ways, Freedom↔Order (late-surfaces.js:30).
- **Policies** carry `deltas` on those traits, a `category`, `helps` / `hurts`
  trades, and `by` bodies (src/sim/policies.js:48–528). For example `rent-cap`
  (:221): market −, helps craft/farm/labour, hurts gentry/trade.
  `zoning`: authority +. `tithe` / `sabbath-rule` / `feast-days` sit in the
  faith category.
- **Walkers** (src/sim/people.js:46) have no names or traits. Households
  (state.js:310) have:
  - `trade`, `lifeStage`, `householdType`, `faithBand` 0–2, `wealth`,
    `savings`, `districtId`, `centreId`, `newcomerUntil`, `formedYear`;
  - an 8-entry `story` ring with `{kind:'trade', from, to}` entries
    (households.js:274–278), plus `moved`, `displaced`, `lost-job`, `loan` and
    others.
- **Names** are derived, not stored: `familyName` and `personName`
  (src/sim/narrative-facts.js:46–55). Body askers are hashed personas with
  traits (institutions.js:1020).
- So "ex-farmer" can be read from `story` today, but only if the change is
  among the last 8 entries. Step 5 adds a durable `h.pastTrade`.

---

## 3. Budgets

### 3.1 Unlock

`unlocks.budgets` is true when **era ≥ 3 (Borough) and at least 5 active
non-Moot bodies**, or at City whatever the count.

- It switches on at the next autumn after the condition holds, so the first
  season is never sprung mid-year.
- A body joins budgeting once it has sat for two years. A brand-new body runs
  its first two years on its founding purse.
- The Moot never has a budget. It is the treasury.
- Wards do have budgets.
- During receivership there is no budget season. The steward funds every body
  at half of last year's grant (see 3.7).

### 3.2 The yearly cycle

| when | what |
|---|---|
| Month 9 (autumn session) | **Budget season opens.** Every budgeting body adds a `budget` card for next year. Budget cards surface at once and do not count against `SESSION_CAP` / `YEAR_CAP`. Major notice: "Budget season: 9 bodies bring their budgets." |
| Months 9–11 | You answer: card by card, or all at once from the season summary. Advisers stage their answers (section 4). |
| Year rollover (`core:year-economy`) | Approved amounts are paid into `funds` (replacing `fundInstitutions`' share for budgeting bodies). An unanswered card **lapses to "same as last year"**. |
| Through the year | Running costs are paid monthly. Approved plans and small things are self-funded when drafted. Anything else escalates. |
| Year end (before rollover) | Spending is totalled. Funds above the reserve go back to the treasury. The year's line goes into `body.budget.history`. A body that ran dry may ask once for a top-up (3.5). |

### 3.3 What a proposal holds

The proposal is built once per body at season open by `draftBudget(state,
body)` in src/sim/budgets.js. It uses cached data only. It never fetches new
works from sim-world: it reads `candidateWorks` through the cache, and
`refreshWorks` keeps its own pace.

```
budget card (kind 'budget')
  from        body id
  year        the year it covers (now + 1)
  lines       [{id, kind, label, cost, templateId?, workId?, need?, struck?}]
    running   'Clerks, tools and small repairs': base × costScale × (0.8 + 0.4·power)
    plan × k  the body's top eligible spending templates by need
              (eligibleTemplates, rules excluded), costed like draftCard does;
              at most 3, and only those it could start next year
    reserve   10% of the above, for small things it did not plan
  asked       sum of lines
  last        {granted, spent, running, plans, other, returned, asked}  from body.budget
  delta       asked vs last granted (+18%)
  outcomes    [{metric, label, from, to}]  first 3 dashboard metrics over the year
              (body.metrics series, sampled quarterly: institutions.js:1837)
  done        last year's self-funded plans (cardHistory outcome 'budget')
  rules       [{policy, title}]  rules it means to ask you for. Information only:
              rules always come to you, and their upkeep is the town's.
  room        the town's room this season (3.6), for the summary
```

**How much a body asks for.** Its running cost plus the plans whose need clears
0.45. The total is scaled by the body's keenness:
- `spendMood` (institutions.js:1392): shy when the chest is low, keen when it
  is full;
- its record: a body that spent under 60% last year asks 15% less.

Each body is capped at 12% of the fiscal base, and wards at 8%. The fiscal
base is `fiscalBase`, the treasury's real income (policies.js:573), not the
broken property-plus-income-tax figure.

**Plan lines** carry the template and work id. That is what lets the body pay
for "that plan" later without asking you.

**Example card text:**

> **Health Board · Budget for year 93**
> Asks **2,860** (last year 2,400 granted, 2,150 spent, +19%)
> · Clerks, tools and small repairs: 760
> · New infirmary house in Millbank: 1,400
> · Slum clearance, Tanner's Row: 500 *(would ask you first: it pulls down homes)*
> · Reserve: 200
> Last year: sickness 31% → 26%. It built a bathhouse.
> It will also ask you for: Clean water rule.

### 3.4 Your choices

| option | effect on the grant | standing |
|---|---|---|
| **Approve** | as asked | patience +0.05. The body's faction mood +0.02 |
| **Trim** (to 90%, 75% or 50%) | scaled. Plan lines drop by lowest need first until the total fits, then running and reserve shrink to fit | 90%: none. 75%: patience −0.05, mood −0.01. 50%: patience −0.12, mood −0.03 |
| **Same as last year** | last year's grant | patience −0.03 if it asked for more, otherwise +0.02 |
| **Refuse** | 0. It runs on its reserve. Everything it wants comes to you as cards, as today | patience −0.2, mood −0.05, unrest +0.01. Counts as `refused++` |
| *(desktop and phone)* **Strike a plan line** | the line is removed before you choose. This records a `not_now` for that template, so the usual 3-year cooldown applies (`blocked`, institutions.js:1405) | patience −0.02 per struck line |

Every budget answer is recorded in `cardHistory` with `kind: 'budget'`,
`choice`, `asked` and `granted`. That feeds approval (section 5) and adviser
performance (section 4).

### 3.5 Working within the budget

The `addCard` branch (docket.js:94) becomes `budgetCovers(state, body, card)`.
It is true only when all of these hold:

- the body has an active budget this year and the card is a **proposal** (not
  a rule card, petition, demand, debate or event);
- the card's chosen spend option costs ≤ `body.funds`;
- one of:
  - the card's template, or template plus work, is an **approved plan line**;
  - the cost is ≤ 15% of this year's grant (a "small thing", paid from the
    reserve);
- the template is not marked `askFirst`. That is a new flag for plans that
  demolish homes or change land use: `slum-clearance`, `redevelop-centre`,
  `grid`, `ring-road`, `widen`;
- the town's opinion of the card (`opinionOf`) is not "unpopular" with
  controversy ≥ 0.5. A body won't spend its purse on something the town hates
  without asking.

When it holds, `selfResolve` (docket.js:465) settles the card:
- it pays from `body:<id>`;
- it records outcome `budget` (renamed from `delegated`);
- it adds a `body.report` line and a minor notice ("The Health Board began an
  infirmary house.").

The body's yearly report card (institutions.js:1883) remains, as a "Noted"
card summarising what it did.

Rule cards always escalate. The Rule Book stays the player's own.

**Running dry.** A body cannot overspend, because `pay` stops at zero
(economy.js:100). When a plan line comes up and funds fall short, the body
adds at most one **top-up card** a year:

> "The River Authority has spent its purse. Grant 600 more for the quay?"

The options are Grant (from the treasury, into funds), Not now, and Refuse.
Not now and Refuse escalate the plan itself as an ordinary card.

**Underspending.** At year end, funds above 25% of the grant go back to the
treasury (`pay(body → treasury, 'budget-return')`). The return shows on the
next proposal. Spending under 60% lowers next year's ask (3.3).

### 3.6 The treasury limit

At season open the season summary shows:

- **Room** = last year's treasury income − rule upkeep − public services −
  loan service − tolls variance, all from `economy.lastYear`.
- **Asked** = the sum of all proposals.
- **Chest** = the current treasury.

If asked exceeds room:

- The summary warns: "Asked 6,400. Room 5,100. Approving all draws 1,300 from
  the chest (192,000)."
- **"Trim all to fit"** scales every unanswered proposal pro rata to room. This
  uses the same arithmetic as `balancePurses` (institutions.js:1246). The
  card-by-card trim rules then pick which lines drop.
- Approving beyond room is allowed while the chest covers it.

At rollover, payment is capped by the treasury as it is today
(economy.js:801). If it is short, every grant is scaled alike, and a
chronicle line says so. Approved budgets count as spending, so `townUpkeep`
(governance.js:121) sees less idle coin. That is intended: budgets are now
where surplus coin goes.

### 3.7 Old purses, petitions and receivership

- **Before the unlock**, and for bodies younger than two years: today's
  `budgetShare` and `grantShare` system, with `fundInstitutions` fixed to use
  `fiscalBase`. This fix is a separate first PR (step 0) because it changes
  the economy.
- **At the unlock**, each body's first proposal starts from its current purse
  income. `body.budget.mode` becomes `'annual'`. `fundInstitutions` and
  `balancePurses` skip annual bodies. `RUNNING_SHARE` spending
  (institutions.js:1866) is replaced by the running line.
- **Petitions to form** (institutions.js:1233) keep their small, standard and
  generous options. The share sets the first two years' purse.
- The **`{budget: x}` card effect** (docket.js:535) on an annual body raises
  this year's grant by `x × fiscalBase`, paid at once, rather than a share.
- **Receivership:** the steward answers the season: same as last year, capped
  at 50%. You can only trim.
- **The `delegate` option is removed.** Bodies now spend their own money
  through the budget instead.

### 3.8 How it appears

- **Season.** A new **Budget season** page in the Council index during months
  9–11, with a count. The middle column holds the budget cards (one open, the
  rest folded, like requests). The side column holds the season summary:
  asked against room, chest, "Approve the rest as asked", "Trim all to fit",
  and adviser notes. Sketches in section 7.
- **Each body's page.** "Its budget" replaces "purse" in `detailsFor`
  (institutions.js:1787). It shows:
  - this year's grant;
  - a spent bar split into running, plans and other;
  - the plan lines, with a tick when started;
  - five years of granted-against-spent mini bars.
- **Town Council page.** The existing "The town's purse" section (City)
  becomes "This year's budgets": every body's grant and spend, and the
  rules' upkeep.

---

## 4. Advisers

### 4.1 Unlock and seats

`unlocks.advisers` is true when **era ≥ 4 (City), at least 7 active non-Moot
bodies, and at least one budget season finished**.

- Arrival: a major notice and the chronicle line "The council takes on
  advisers to share the load."
- The first slate is offered at once.

Advisers sit on a **bench** at the town hall, the "guild of guilds". They are
not a body: they have no docket of their own, no patience, and no petitions.
There are up to three **seats**, each with a portfolio (an **area**).

**Areas are matched by tags, not listed by body kind** (decided). A body
belongs to an area by what it works on, read from tags every body already
carries, so a body added later (including one proposed by the model over an
existing mechanical template, see below) falls into the right area by itself.

The rule, `areaOf(kind)` in src/sim/advisors.js:

1. **Category tags.** Every template a body drafts (`TEMPLATES[t].category`)
   and every rule it drafts (`POLICIES[id].category` for the policies whose
   `by` names it, `INSTITUTIONS[kind].policies`) counts one point for the area
   that owns that category:

   | area | owns the categories |
   |---|---|
   | **Land, trade and labour** (`land`) | food, land, trade, labour, tax |
   | **Works, river and order** (`works`) | infrastructure, environment, civic, health |
   | **Faith, learning and festivity** (`learning`) | faith, education |

2. The area with the most points wins.
3. **Tie-break**, in order: the body's `faction` (farmers, crafters,
   merchants, labourers → land; scholars, clergy → learning); then its `axis`
   (a dominant `authority` lean → works); then the fixed order works, land,
   learning.
4. The Moot is never in an area.

Under this rule the current bodies land as follows (points land / works /
learning; checked against the catalogue in this worktree, no ties):

| body | points | area |
|---|---|---|
| agri-council | 9 / 2 / 0 | land |
| trades-guild | 7 / 2 / 0 | land |
| exchange | 8 / 0 / 0 | land |
| union | 5 / 0 / 0 | land |
| ward | 2 / 0 / 1 | land |
| river-authority | 1 / 11 / 0 | works |
| planning | 6 / 10 / 0 | works |
| health-board | 1 / 9 / 0 | works |
| watch | 0 / 4 / 0 | works |
| parish | 2 / 1 / 5 | learning |
| school-board | 1 / 0 / 5 | learning |
| arts-society | 2 / 0 / 6 | learning |

This gives the same grouping as the earlier fixed table. Faction alone would
leave five bodies unplaced (health-board, planning, watch, ward,
arts-society), and axis alone leaves three with no lean and puts the parish
and the school board on opposite ends of one axis though they share an area,
so both serve only as tie-breaks. A test pins the table above so a catalogue
change that moves a body is noticed.

*Later, not in scope:* bodies proposed by the model would be name and purpose
prose laid over an existing mechanical template (its metrics, templates and
rules), checked against a schema, and stored in the save so replays stay
deterministic. Because areas read the template's tags, such a body needs no
area of its own.

- First seat: at the unlock. You pick its portfolio when you hire.
- Second seat: at 10 sitting bodies, or Metropolis.
- Third seat: at Metropolis with 10 or more bodies.
- A body with no seated adviser comes to you, as today.
- The Moot's own cards (Town Council plans) never go to an adviser.

### 4.2 Candidates from real townsfolk

`drawSlate(state, portfolio)` in src/sim/advisors.js builds the slate. It runs
on the unlock, on a dismissal or resignation, and on "See others" (at most
once a year). There is no rng. Variety comes from
`hash32(seed, year, household.id)`.

1. **Pool.** Households with `lifeStage` family or elder, at least 8 years in
   town (`formedYear`), not newcomers, and not already on the bench. Prefer
   wealth band middling or wealthy, or trade clerical, clergy or gentry: they
   have the standing. This is one O(households) filter. Take the 12 with the
   highest standing score.
2. **Person.** One adult per household. The name is derived like
   `personName`: given name from `hash(household.id, 1)` plus `familyName`.
   It is **stored** on the adviser so it stays stable if the household
   changes.
3. **Background.** One label:
   - "Ex-farmer" / "Ex-smith" if `h.pastTrade` (or a `story` trade entry)
     differs from the current trade;
   - otherwise the current trade: "Farmer", "Master smith", "Merchant",
     "Clerk", "Chaplain", "Labourer's son", "Gentry";
   - plus "From Millbank" if their centre is not the seat, and "Old family" if
     formed 40+ years ago.
4. **Beliefs**, each −1..1, from data the sim has:
   - **Four axes** (industry, market, innovation, authority):
     - start from their trade, using the same leanings as the bodies' `axis`
       table: farm industry −.5; craft market −.3, innovation −.3;
       trade/gentry market +.6; labour market −.6; clerical innovation +.5,
       authority +.3; clergy innovation −.5;
     - add their faction's reaction lean: the share of protest + strike +
       leave against support in the `react_to_policy` slice answers for their
       trade pushes authority −;
     - add a hash jitter of ±0.3;
     - add 0.2 × the town's current traits (people lean with their town).
   - **Faith**: faithBand 0 → −0.6 ("Cool on the chapel"); 2 → +0.6.
   - **Thrift**: middling or wealthy savers with savings ≥ 2 years of income
     → + ("Careful with coin"). Poor households → − ("Spend it on people").
5. **Pet issues.** One or two policies they feel strongly about. Pick policies
   whose `helps` / `hurts` include their trade, or whose trait `deltas` align
   or clash most with their axes. The stance follows the sign. A merchant
   gets "Against the rent cap" (rent-cap hurts trade). A clerk gets "For
   building zones".
6. **Temper.** One word from the hash: Tactful, Blunt, Shrewd or Steady.
   - Tactful: a body's patience loss when they refuse is ×0.7.
   - Blunt: ×1.3, but they answer within one month.
   - Shrewd: plans cost 5% less (they haggle).
   - Steady: no override-driven resignation.
7. **Salary.** 1.5–3% of `fiscalBase` a year, higher for gentry and clerical
   candidates and for those with more pet issues. It is paid monthly from the
   treasury **to their household** (`pay(treasury → household)`), so money is
   conserved and their family prospers.

Pick 3 candidates (4 at Metropolis) from the 12. Take the highest standing
first, then the most different (largest belief distance from those already
picked). The slate always shows real disagreement.

**Chip labels.** The user's examples map to these: Ex-farmer (background),
For planning (authority ≥ +0.4 or a zoning pet issue), Against the rent cap
(pet issue), Against the chapel's hold or Cool on the chapel (faith ≤ −0.4),
Careful with coin (thrift ≥ 0.4), New ways or Old ways (innovation),
Markets or Commons (market).

### 4.3 Hiring

- Choose a candidate and a portfolio (for the first seat).
- No fee. The salary starts next month.
- Chronicle line: "Edda Fenwick, once a farmer, joins the council as adviser
  for land and trade."
- Hiring someone whose pet issue is a rule in force against them is allowed.
  They will press to change it: they bring the rule card for that policy into
  their portfolio's drafting focus, through `focusBody` (institutions.js:1689).

### 4.4 What "answer for you" means

When a card from a portfolio body is added (`addCard`, after the budget
check), the seated adviser forms an answer: `advise(state, adviser, card)`.
It is a pure function with no rng.

```
for each option o (excluding Negotiate):
  score(o) = Σ_axis  belief[axis] · axisPush(o)          // policy deltas at the new level;
                                                          // template effects' deltas; for a
                                                          // spend, the body's own axis lean
           + faith  · faithPush(o)                        // faith-category rules and templates
           + thrift · (−cost(o) / fiscalBase) · 4         // careful with coin dislikes dear plans
           + 0.8 · townOpinion(o)                         // opinionOf(card.stances): (for − against);
                                                          // advisers read the room
           + 0.4 · tradeAffinity(o)                       // helps/hurts include their own trade
           + 1.0 · petIssue(o)                            // ±1 when o moves their pet rule
           + 0.3 · bodyRecord                             // keeps a strong, patient body sweet
status quo (not_now) scores 0; refuse scores −0.2 (it costs patience)
answer = argmax, ties broken by option key
rationale = the two terms with the largest |contribution|, as words:
  "For planning: it lays out the new grid." · "Careful with coin: 900 is dear."
```

The answer is **staged, not applied.** The card gets
`card.advice = {adviserId, option, rationale, month, dueMonth}`.

- `dueMonth` is the next quarterly session after one full season (3 months),
  or 1 month for a Blunt adviser.
- The card surfaces as usual. Session caps apply only to cards the adviser
  escalates. Staged cards sit under "Your advisers will answer".
- You can **Let it stand** (applies now), **Change** (pick another option:
  `rule()` as the player, logged as an override), or ignore it.
- At `dueMonth`, `docketMonthly` applies the answer through
  `rule(state, cardId, option)` with `by: 'adviser:<id>'`. Rules adopted this
  way show the adviser as enacting them, which `adoptPolicy` already supports
  (policies.js:618). The effects and `cardHistory` are exactly those of a
  player ruling, plus `advisedBy`.
- Cards expire normally. An advised card's `expiresMonth` is always after its
  `dueMonth`.

**Per-seat mode** (a three-way control on the adviser card):

| mode | answers | escalates (with a recommendation chip) |
|---|---|---|
| **Advise only** | nothing | everything, with "Edda would approve" on the card |
| **Routine** *(default)* | proposals, budget cards, reports ("Noted"), top-ups | rule cards on their pet issues, demands, debates, petitions, `askFirst` plans |
| **All in their area** | also rule cards, demands (choosing Negotiate is allowed), and debates between two of their bodies | events, petitions to form or dissolve a body, debates with a body outside the portfolio |

Events (floods, fires) always come to you, but the adviser's
recommendation shows on the card.

**Prose.**
- Version 1 builds the rationale from fixed templates.
- Version 2 can ask the narrator for a one-line memo in the adviser's voice
  (`setAdviceProse`, the same pattern as `setCardProse`, docket.js:606). This
  is cosmetic; the mechanics never read it.
- A later option is a decision kind `adviser_answer` with this scorer as its
  `fallback`, letting the model shade the choice. That would make online and
  offline runs differ, as every model-asked kind already does. Recommended:
  not in version 1 (see 9.4).

### 4.5 Performance

`advisersYearly` keeps, per adviser per year:

| metric | source |
|---|---|
| Answered / let stand / **changed by you** | `card.advice` outcomes |
| Coin spent through their answers, and against room | `cardHistory` costs, budget grants |
| Their bodies' standing | average patience and power of portfolio bodies (start of tenure → now) |
| Their bodies' dashboards | % change of each portfolio body's first two metrics (`body.metrics` series) |
| Their groups' mood | portfolio factions (`INSTITUTIONS[kind].faction`) mood change |
| Their groups' approval | section 5, constituency rows |

These roll up into one **Standing** score, 0–100:

- 30: you rarely changed their answers;
- 25: their bodies' dashboards improved;
- 20: their groups' approval;
- 15: their bodies are patient;
- 10: within budget room.

It has a yearly sparkline.

The adviser card shows the name, background chip, belief chips, four small
two-ended scales (the compass style from late-surfaces.js:39), pet issues,
salary, tenure, "Answered 14 · you changed 3", the Standing trend, and the
last five answers.

### 4.6 Dismissal, resignation and retirement

- **Dismiss.** Confirm, then pay half a year's salary as severance.
  - Chronicle line, and a major notice: "You dismissed Edda Fenwick."
  - If their Standing was ≥ 60, their own trade's faction mood −0.03 ("a
    popular adviser").
  - Staged answers are withdrawn and the cards return to you.
  - The seat stays empty and a new slate is drawn at once. The dismissed
    person is not offered again for 10 years.
- **Resign.** If you change more than half their answers in a year (and they
  are not Steady), or you enact a rule against their pet issue, they may
  resign at year end.
  - The rule is deterministic: they resign if both happen, or if the override
    share is ≥ 0.6.
  - Chronicle line: "Hal Brennick resigned: the council would not hear him on
    the rent cap."
- **Retire or leave.** If their household leaves town, dissolves, or the
  adviser has served 20 years, the seat empties with a minor notice.
  - This is checked yearly against `state.households`. No hook is needed in
    the household code.

### 4.7 Advisers and budgets

- In Routine or All mode, the adviser **answers the budget cards** of their
  portfolio. The scorer's thrift belief decides between approve and trim:
  thrift ≥ 0.4 trims to 90%, or to fit room when over. Their axes favour
  bodies whose own axis matches.
- Each staged budget answer shows in the season summary ("Edda: approve 3,
  trim 1").
- **"Trim all to fit"** uses the most senior adviser's thrift as the default
  depth.
- Advisers never answer the Moot's own proposals, and never the town-wide
  "room".

### 4.8 Cost against value

Three advisers cost about 6% of the town's income in salaries. In return, a
City with 12 bodies sends you perhaps 4–6 cards a year instead of 12–20.
Their answers are explainable and can be overruled for a season.

### 4.9 Later: adviser instructions

The `standingOrderFor` match shape (institutions.js:1166) is reused as
per-seat **instructions**: "Never raise the tithe", "Always fund paving under
400". An instruction overrides the scorer. This is not in version 1. It is
listed so the code can be repurposed rather than deleted.

---

## 5. Approval

### 5.1 Unlock

- Computed **yearly from year 0**, silently, so the chart has history when it
  appears.
- **Shown at Borough** (`unlocks.approval`: era ≥ 3), with a "New: Approval"
  nudge.
- Before then, the People view keeps its moods only.

### 5.2 What it is

"Of the people, how many approve of how you rule." It is not an election and
not wellbeing:
- **Wellbeing** (pressures.js:222) is how life is.
- **Approval** is how people judge *you*. Mood already folds wellbeing in, but
  approval adds your rulings and their reactions.

For each household group `g` (one pass over `buildSlices().members`, which is
O(households) once a year):

```
s(g) = 0.50 · (2·mood(faction(g)) − 1)                  // faction mood, centred (factions.js:149)
     + 0.20 · rulings(faction(g))                       // last 3 years of cardHistory stances, decayed 0.6/yr:
                                                        //   +1 for and accepted / against and refused,
                                                        //   −1 against and accepted / for and refused,
                                                        //   ±0.5 split; by advisers counts the same
     + 0.15 · reaction(g)                               // react_to_policy slice answers for g's trade,
                                                        //   wealthBand, district, centre (pooled like
                                                        //   populationShares): support + accept/2 − grumble/2
                                                        //   − protest − strike − leave; latest and prev rule
     + 0.10 · −leaving(g)                               // household_stay_move: (emigrate + move_to_centre) × 5
     + 0.05 · −petitioning(faction(g))                  // petition: gather + leave
approve(g) = logistic(4 · s(g))                         // share approving, 0..1
```

- **Overall** = the people-weighted mean.
- **Rows** for each dimension: faction, trade, wealthBand, district, centre,
  lifeStage, faithBand, newcomer. Each is the people-weighted mean of its
  members.
- Shown as a percentage, with "strongly against" (approve < 0.25) as a
  secondary figure.

The **reaction ledger** keeps more than the newest rule. When a
`react_to_policy` sweep finishes (scheduler.js:659), its pooled net is folded
into `approval.ledger[dim=value] = 0.7·old + 0.3·net`. That is O(slices) per
rule change.

### 5.3 Why it moved

The yearly pass stores each term's contribution, overall and per faction. It
splits the mood term into the parts `factionsYearly` already computes. For
this, `factionsYearly` writes `f.moodParts = {rules, wellbeing, unrest,
looks}`: four numbers, no new work.

The **drivers** are the largest changes against last year, each turned into
words with a sign and points, at most three up and three down:

- **A rule.** The rules term splits by policy through `ruleBalance`
  (factions.js:130), weighted by the people in the factions it helps or hurts:
  "The rent cap: Makers glad, Merchants sore (+2)".
- **A ruling.** The rulings term's biggest single entries: "You refused the
  guild hall (−3)", "Your adviser approved the turnpike (+1)".
- **A rule reaction.** "Labourers grumbled at the hours cap (−1)".
- **Life.** The wellbeing parts (food, homes, work, health, calm,
  pressures.js:224–233): "Food ran short (−4)", "Families waiting for homes
  (−2)".
- **Unrest and looks.** "The streets are shabbier in Tanner's Row (−1)".
- **Leaving.** "Rents push poor families to think of leaving (−2)".

### 5.4 History

`state.approval.history` holds `[{y, all, f: {factionId: v}}]`, capped at 200
entries like `indicatorHistory`. Each year also gets one `indicatorHistory`
entry, `approval`, so the end page and narrator facts
(chronicle.js:110 `chronicleYearFacts`) can quote it.

### 5.5 Where it shows

- **Top bar:** an "Approval 62%" metric with a trend caption ("+4 this year"),
  unlock key `approval`. It sits after Wellbeing (topbar.js:7–13). Clicking it
  opens People at the Approval section. On phones the top bar keeps its
  current three-metric cap: Approval replaces Wellbeing there, and Wellbeing
  stays in People.
- **People view** (src/ui/components/people.js), a new section above "Groups
  in town":
  - the big figure and a chart over the years (the existing `sparkline.js`,
    enlarged);
  - group bars, with tabs for Groups, Wealth, Districts, Ages and Faith;
  - "Why it moved", with the drivers.
  - Each faction row gains its approval figure next to its mood word.
- **Chronicle:** one yearly line when it moves 5 points or more ("Your
  standing fell: the merchants are sore about the rent cap.").
- **Year-end major notice:** gains "Approval 58% (−4)".
- **Adviser cards** use the constituency rows (4.5).

### 5.6 Feedback into the sim

Version 1 reports only. Nothing reads `state.approval` except the view.

A suggested phase 2 (see 9.5):
- below 35% for two years in a row: the `petition` kind's `gather` weight goes
  up (through `weightsFor`, policies.js:697) and a small unrest drift starts;
- above 70%: body patience regenerates faster.

There are no elections and no game over.

---

## 6. Unlock ladder

| era (floor–ceiling yrs) | condition | existing unlocks (view.js:404) | new |
|---|---|---|---|
| Hamlet 0 | – | chronicle, docket | approval **recorded** silently |
| Village (6–15) | 120 people, 1 body | ruleBook, people | – |
| Town (25–45) | 450 people, 3 bodies, 40 roads | bodies, bodyTabs (2+ bodies), overlays | – |
| Borough (55–80) | 1,200 people, better homes, known for something | debates, tensions (delegation and standingOrders retire) | **approval shown**. **budgets** once 5+ bodies, at the next autumn |
| City (90–115) | 3,000 people, 6 bodies, 10 rules | budget sheet (becomes "This year's budgets"), tensionsDashboard, compass | **budgets** if not yet. **advisers**, seat 1, once 7+ bodies and one season done. Seat 2 at 10+ bodies |
| Metropolis (125–140) | 6,000 people, fine homes, health | endPreview | adviser seat 2 if not yet. Seat 3 with 10+ bodies. Slates of 4 |

All thresholds are constants in src/sim/budgets.js and src/sim/advisors.js
(`BUDGET_MIN_BODIES = 5`, `ADVISER_MIN_BODIES = 7`, `SEAT_BODIES = [7, 10, 10]`)
so they can be tuned against fixtures.

---

## 7. Data model and save migration

### 7.1 Additions

```js
// per body (normaliseBody fills defaults)
body.budget = {
  mode: 'share' | 'annual',
  year, asked, granted,                 // this year's
  lines: [{id, kind: 'running'|'plan'|'reserve', label, cost, templateId?, workId?, need?, struck?, started?}],
  spent: {running, plans, other},
  history: [{y, asked, granted, spent, returned, choice}],   // cap 30
  topUpYear: null,
};

state.governance.budgets = {
  season: {year, openedMonth, cardIds: []} | null,
  seasons: 0,                           // completed seasons (adviser unlock)
  unlockedYear: null,
};

state.advisers = {
  seats: [{id: 's1', portfolio: 'land'|'works'|'learning', adviserId: null, mode: 'routine', vacantSince}],
  roster: [{id, name, householdId, background: {label, trade, pastTrade, centreId},
            beliefs: {industry, market, innovation, authority, faith, thrift},
            issues: [{policy, stance: 1|-1}], temper, salary, hiredYear, leftYear?, leftWhy?,
            stats: {answered, stood, changed, spent, byYear: [{y, standing, answered, changed}]}}],  // byYear cap 60
  slate: {year, portfolio, candidates: [/* same shape as roster entries, unsaved stats */]} | null,
  barred: {householdId: untilYear},
  nextId: 1,
};

card.advice = {adviserId, option, rationale: [{term, text, weight}], month, dueMonth};  // on docket cards only
cardHistory[i].advisedBy = adviserId;    // optional
cardHistory[i].asked / granted           // budget cards only

state.approval = {
  year, overall, strongAgainst,
  rows: {faction: {id: {v, n}}, trade: {...}, wealthBand: {...}, district: {...}, centre: {...},
         lifeStage: {...}, faithBand: {...}, newcomer: {...}},   // v approval, n people
  parts: {mood, rulings, reaction, leaving, petitioning},       // overall contributions
  drivers: [{key, kind, text, about, points}],                   // ≤ 3 up, ≤ 3 down
  ledger: {'trade=farm': net, ...},                              // react_to_policy fold
  reactions: [{y, policy, change, net, worst, best}],            // latest rule reactions, cap 12
  history: [{y, all, f: {}}],                                    // cap 200
  leavingBy: {poor, middling, wealthy},                          // share thinking of leaving
  base: {slope, f: {id: {mood, target, rules, looks, log}}, life, unrest, terms},
                                                                 // last pass's parts, for the next
};

faction.moodParts = {rules, wellbeing, unrest, looks};   // written in factionsYearly
faction.moodLog = {rulings, reactions, displaced, events};   // nudges since the last pass (nudgeMood)
household.pastTrade = 'farm';                            // set in assignTrade (households.js:274)
```

### 7.2 Migration

- **Do not bump `SAVE_VERSION`** (state.js:14). `restore` refuses any older
  version outright (src/sim/serialize.js:47–49). Every addition above is
  optional and is filled on restore:
  - `initGovernance` / `normaliseBody` add `body.budget = {mode: 'share', …}`
    and `governance.budgets`.
  - New `initAdvisers(state)` and `initApproval(state)` run from governance
    `init` and `restore` (governance.js:188–216): `state.advisers ??= …`,
    `state.approval ??= …`.
  - `household.pastTrade` stays undefined in old saves. The background falls
    back to `story` entries.
- An old save from a Borough or City town gets **budgets at its next autumn**
  if the condition holds, starting from current purse levels.
- Advisers unlock after one finished season, so an old City save waits about
  a year.
- Approval history starts at the restore year. The first year shows a figure
  but no trend.
- **Determinism:**
  - No new code calls `rng(state)`. Slates use `hash32`; advice is a pure
    argmax; approval is pure arithmetic.
  - Existing seeded runs and fixtures stay byte-identical until a feature
    switches on. The exceptions are the fixes that change the economy on
    purpose: the step-0 `fundInstitutions` fix, and the retirement of the
    `delegate` option.
  - Adviser answers apply in `docketMonthly`, in docket order.
- **Transient:** none needed. The approval pass is yearly and saved, so a
  restored game reads the same numbers.

### 7.3 Performance

| work | cadence | cost |
|---|---|---|
| Approval pass | yearly | O(households × 8 dims) over `buildSlices` members (already built) |
| Reaction ledger fold | per `react_to_policy` sweep | O(slices) |
| `draftBudget` per body | yearly (season open) | `eligibleTemplates` once per body, using the works cache only |
| Budget payments | yearly + running line monthly | O(bodies) |
| `budgetCovers` / `advise` | per card added | O(options × terms) |
| Staged-answer apply | monthly | O(docket) |
| Slate | on unlock, dismissal or resignation, ≤ yearly | O(households) filter + top 12 |
| Adviser stats | yearly | O(cardHistory this year + portfolio bodies) |

There is no per-tick work, and no new per-person work.

---

## 8. UI

The direction set in this session holds:
- the Council is a HUD, not a modal, and grows with progress;
- notices sit top-left (majors linger about 20 s, minors fade in 5–6 s;
  notices.js:19–24);
- on phones, one Council tab with the bodies as a chip strip.

### 8.1 Council index (desktop)

```
┌ Council ───────────────────────────────────────────────────────────────┐
│ ▣ Town Council      4 │  [ middle: cards for the page ]  │ [ side ]     │
│ ◆ Budget season     9 │                                  │              │
│ ✦ Advisers          2 │                                  │              │
│ BODIES                │                                  │              │
│   Agricultural C.  1  │                                  │              │
│   Health Board        │                                  │              │
│   …                   │                                  │              │
└────────────────────────────────────────────────────────────────────────┘
```

- "Budget season" is only listed during months 9–11, and while unanswered
  budget cards remain.
- "Advisers" appears with the unlock. Its count is answers staged for your
  review.

### 8.2 Budget season page

```
┌ Budget season · year 93 ─────────────────────────────────────────────────────┐
│ 6 of 9 answered                                                               │
├──────────────────────────────────────────────┬────────────────────────────────┤
│ ▾ Health Board · asks 2,860  (+19%)          │ THE SEASON                     │
│   Clerks, tools and repairs .......... 760   │ Asked   ████████████░░  6,400  │
│   [x] Infirmary house, Millbank ..... 1,400  │ Room    █████████░░░░░  5,100  │
│   [x] Slum clearance (asks you first)   500  │ Chest              192,000     │
│   Reserve ............................ 200   │                                │
│   Last year: granted 2,400, spent 2,150      │ [ Approve the rest as asked ]  │
│   Sickness 31% → 26% · built a bathhouse     │ [ Trim all to fit ]            │
│   Also asks you for: Clean water rule        │                                │
│   Edda would approve: careful but the        │ ADVISERS                       │
│   sickness numbers are good.                 │ Edda (land): approve 3, trim 1 │
│   [Approve] [Trim 90 ▾] [Same as last year]  │                                │
│   [Refuse]                                   │ BY BODY                        │
│ ▸ River Authority · asks 1,900  (+4%)        │ Health      2,860  ▲19%        │
│ ▸ Planning Office · asks 1,450  (−8%)        │ River       1,900  ▲4%         │
│ ▸ …                                          │ …                              │
└──────────────────────────────────────────────┴────────────────────────────────┘
```

### 8.3 An adviser's staged answer on a card

```
┌ A proposal · Planning Office ─────────────────────────────┐
│ Widen the high street                         cost 1,200  │
│ …why…                                                      │
│ ┌ Edda Fenwick will approve this in 2 months ───────────┐  │
│ │ For planning: it clears the busiest road.            │  │
│ │ Careful with coin: 1,200 is dear, but room allows.   │  │
│ │ [Let it stand]  [Change answer ▾]                    │  │
│ └───────────────────────────────────────────────────────┘  │
│ Town opinion: Popular ███████░░                            │
└────────────────────────────────────────────────────────────┘
```

### 8.4 Advisers page

```
┌ Advisers ─────────────────────────────────────────────┬─────────────────────────┐
│ LAND, TRADE AND LABOUR                                │ STANDING                │
│ ┌ Edda Fenwick ─ Ex-farmer · Old family ────────────┐ │ 71 ▁▃▅▆▇  (3 years)     │
│ │ For planning · Against the rent cap · Careful with│ │ Answered 14             │
│ │ coin · Tactful                                     │ │ You changed 3           │
│ │ Fields ●───┼──── Industry   Commons ──┼─●── Markets│ │ Bodies' patience  ▲     │
│ │ Old ways ──┼●── New ways    Freedom ──┼──●─ Order  │ │ Farmers' approval 58 ▼  │
│ │ Salary 480 a year · since year 91                  │ │                         │
│ │ Mode: ( Advise only | ● Routine | All )            │ │ RECENT ANSWERS          │
│ │ [Dismiss]                                          │ │ ✓ Seed exchange         │
│ └────────────────────────────────────────────────────┘ │ ✎ Guild hall (changed)  │
│ WORKS, RIVER AND ORDER (opens at 10 bodies)           │ ✓ Budget: Agri, trimmed │
│ FAITH, LEARNING AND FESTIVITY (opens at Metropolis)   │                         │
└───────────────────────────────────────────────────────┴─────────────────────────┘
```

**A vacant seat** shows the slate: 3 or 4 candidate cards with the same chips
and scales, a [Hire] button each, and [See others] at most once a year.

### 8.5 Body page

The side column's "Its budget" section replaces the purse row:

```
Its budget · year 93           granted 2,400
Spent  ██████████░░░░  1,610   (running 600 · plans 1,010)
✓ Infirmary house  · ○ Slum clearance (asks you)
Last 5 years  ▅▆▆▇▆ granted / ▄▅▆▆▅ spent
```

### 8.6 Phone

```
┌ Council ───────────────────────────────┐
│ [Council 4] [Budgets 9] [Advisers 2]   │  ← chip strip, scrolls; bodies follow
│ [Agri 1] [Health] [River] …            │
├────────────────────────────────────────┤
│ Asked 6.4k · Room 5.1k  [Trim to fit]  │  ← sticky season strip (Budgets only)
├────────────────────────────────────────┤
│ Health Board · asks 2,860 (+19%)       │
│ 4 lines ▾   Last year 2,400 / 2,150    │
│ Sickness 31% → 26%                     │
│ Edda would approve                     │
│ [Approve] [Trim ▾] [Same] [Refuse]     │
│              ‹  2 / 9  ›               │
└────────────────────────────────────────┘
```

- Adviser cards stack one per seat, with the belief scales collapsed under
  "Beliefs ▾".
- Staged answers show the same banner in compact form: "Edda will approve ·
  [Stand] [Change]".

### 8.7 Notices

| event | kind |
|---|---|
| Budget season opens | major: "Budget season: 9 bodies bring their budgets" → opens the Budget season page |
| A body self-funds a plan | minor: "The Health Board began an infirmary house" |
| A top-up is asked | major (a request card) |
| An adviser stages answers | one major per session: "Your advisers will answer 3 requests" |
| An adviser's answer applied | minor |
| Dismissed, resigned or retired | major |
| Unlocks | the existing "New: Budgets", "New: Advisers" and "New: Approval" nudges (`UNLOCK_NAMES` in app.js) |
| Approval moves ±5 | with the year-end major |

---

## 9. Implementation plan

Each step is one PR with tests. Steps 1–2 and 3–4 are independent of each
other. Steps 5–7 need 3.

**Step 0: fix the purse base** (small, separate)
- Files: src/sim/economy.js (`fundInstitutions`: use property + income +
  site tax, or `fiscalBase`).
- Test: tests/sim-core.test.js (a land-value-tax town funds its bodies; money
  is conserved).
- This changes economic outcomes on purpose. Regenerate src/sim/fixtures
  only if the tests need it.

**Step 1: approval in the sim**
- New src/sim/approval.js (`approvalYearly`, `foldReaction`).
- src/sim/factions.js (`moodParts`).
- src/sim/governance.js (call after `factionsYearly`; init and restore).
- src/sim/decisions/scheduler.js (`finishSweep` → `foldReaction` for
  `react_to_policy`).
- src/sim/pressures.js (`approval` added to history).
- src/sim/view.js (`selectApproval`; `unlocks.approval`).
- New tests/sim-approval.test.js:
  - pure: two runs give the same numbers;
  - an accepted card a faction opposed lowers that faction;
  - a save round-trip keeps it.

**Step 2: approval UI**
- src/ui/components/topbar.js (metric).
- src/ui/components/people.js (section, chart, rows, drivers).
- src/ui/components/sparkline.js (larger variant).
- src/ui/app.js (wiring, unlock name).
- src/ui/components/notices.js (year-end line).
- src/ui/dev/stub-view.js and stub-sim.js (stub data).
- src/ui/components.css and layout.css.
- tests/browser/ui.spec.js (approval shows at Borough).

**As built (steps 0–2).** Where the build differs from the plan above:

- *Step 0.* Held at first, then shipped with budgets (owner's decision: "Hold
  the purse fix until the budgets step, since budgets replace purses
  anyway"). Before budgets, the base is property + income + site tax (`purseBase`,
  economy.js), the figure `state.budget.income.tax` already showed. The bug
  is wider than 2.2 says: property tax on homes is tiny in every town (14–285
  a year against 550–18,000 of site tax in balance runs), so purses were near
  zero everywhere, not only under the land value tax. Funding them is a real
  economic change: in balance runs (5 seeds, years 0–100) purses rise from
  hundreds of coin in total to 38,000–285,000, mean population at year 60
  goes from 1,579 to 1,621, and the grown `town` fixture comes out
  differently (it no longer has a market). Tests that read that fixture's
  incidental layout fail (crowds ×7, relocation, render-view rows) and the
  growth guard's seed 24757 reaches hunger 0.26 in year 100 (limit 0.25).
  Everything else passes with or without step 0.
- *Step 1.* `approvalYearly` runs in governance `year()` right after
  `factionsYearly`; `initApproval` fills old saves on restore with a figure
  at once (history from the restore year). It reads households through
  `memberships` without touching the `buildSlices` cache. The rulings term's
  split stance counts 0 (half pleased, half not); deferrals and lapses count
  −0.5. No `indicatorHistory` key: an old save's list would not line up with
  the year index that `chronicleYearFacts` uses, so `approval.history` keeps
  `{y, all, f}` and `chronicleYearFacts` reads it.
- *Why it moved* follows the mood's own arithmetic: a faction's mood moves a
  fifth of the way to its target each year, so 0.2 × each target part's
  change (each rule by policy, each part of wellbeing, unrest, looks) is a new
  push, 0.2 × (last target − last mood) is "earlier news still sinking in",
  and the year's direct nudges are 0.8 × their sum. To name those nudges,
  every direct write to a faction's mood now goes through `nudgeMood(f, next,
  source)` (factions.js), which keeps `f.moodLog` by source (rulings,
  reactions, displaced, events) until the yearly pass. The values written
  are exactly as before. The other terms compare their contributions; all are
  in approval points, linearised at each household's slope.
- *Step 2.* The year-end line went into app.js (the notice text), not
  notices.js. On phones Approval takes Wellbeing's place at every width, and
  the four numbers sit closer up to 440 px (the three-metric cap would have
  hidden it below 401 px). The browser tests are tests/browser/approval.spec.js.

**Step 3: budgets in the sim**
- New src/sim/budgets.js (`draftBudget`, `openSeason`, `settleBudget`,
  `budgetCovers`, `payBudgets`, `closeYear`, `topUpCard`).
- src/sim/docket.js:
  - the `budget` kind in `PRIORITY` and `finishOptions`;
  - surface without caps;
  - `expire` → same as last year;
  - the `addCard` branch → `budgetCovers`;
  - `selfResolve` outcome `budget`;
  - remove the `delegate` option.
- src/sim/institutions.js:
  - `normaliseBody` defaults;
  - `institutionsYearly`: the running line replaces `RUNNING_SHARE` for annual
    bodies;
  - `balancePurses` skips annual bodies;
  - `askFirst` flags on templates;
  - `detailsFor`.
- src/sim/economy.js (`fundInstitutions` skips annual bodies; `payBudgets`
  call).
- src/sim/governance.js:
  - season open in `month()` at month 9;
  - year close;
  - receivership rule;
  - actions `answerBudget(state, cardId, {choice, trim, struck})` and
    `trimAllToFit(state)`.
- src/sim/index.js and src/ui/bridge.js (export the actions).
- src/sim/view.js (`cardView` for budget cards; `selectBudgetSeason`;
  `selectBodies` budget fields; `unlocks.budgets`).
- src/sim/text/voice.js (lines).
- New tests/sim-budgets.test.js:
  - money is conserved through a season;
  - an approved plan self-funds and a rule card still escalates;
  - lapse → same as last year;
  - over room → trim to fit;
  - a save round-trip mid-season;
  - an old save gains `body.budget`.

**Step 4: budgets UI**
- src/ui/components/card.js (budget card renderer: lines with strike toggles,
  trim menu).
- src/ui/components/council.js (Budget season page and index entry, season
  summary side).
- src/ui/components/body-view.js and late-surfaces.js ("Its budget"; "This
  year's budgets").
- src/ui/components/docket.js (budget cards in the pager).
- src/ui/app.js (season notice, phone chip).
- src/ui/model.js (minor keys).
- CSS, dev stubs, tests/browser/ui.spec.js.

**As built (steps 3–4).** Where the build differs from the plan above:

- *When.* The season opens in month 9, the year's last quarterly session
  (winter in this calendar, not autumn), from Borough with five sitting
  bodies or at City, never under the steward. A body brings a budget after
  two years sitting.
- *Purses before budgets* come from property + income + site tax
  (`purseBase`); the petition to form a body quotes its purse from the same
  base. A body's first budget starts from that purse income ("last year").
  `fundInstitutions` and `balancePurses` skip bodies on a budget (and bodies
  with an answered budget waiting for the turn); `RUNNING_SHARE` spending
  stops for them, and the running line is paid monthly.
- *Sizes.* Running line 40 × `costScale` × (0.8 + 0.4·power), about the old
  purse; reserve 10%. With the 12% cap and a 0.45 need, no plan ever made a
  budget in balance runs (most templates cost 20–75% of the fiscal base), so
  the cap is 20% (wards 12%) and the need 0.4. Big works still come to you.
  A body's own plans already waiting on the docket are candidates too:
  approving the budget approves them, and they go ahead from the grant at
  the year's turn (`settleOpenFromBudget`).
- *Answers.* `rule(card, 'approve'|'trim90'|'trim75'|'trim50'|'same'|'refuse')`;
  `strikeBudgetLine` marks a plan line first; `approveAllBudgets` and
  `trimAllToFit` answer the rest (the trim is a `trim` answer with a factor).
  An unanswered card lapses at the turn to last year's figure. The steward
  pays half of last year's grant whatever the chest holds.
- *Within the budget.* `budgetCovers` replaces the delegation branch in
  `addCard` (standing orders stay until step 8). The "Let them decide" option
  is gone; `selfResolve` and `setDelegated` remain for step 8 to remove. It
  reads the factions' local stances (`localStances`, scheduler.js) without
  queuing a question. A top-up card escalates the plan as an ordinary
  (escalated) card when you say Not now or Refuse.
- *Money.* Every flow has its own reason: `budget-grant`, `budget-return`,
  `budget-topup`, `body-running`, and `body-grant` (negotiated grants); the
  old `'bodies'` reason collided with `economy.year.bodies`. Account refs now
  split at the first colon only, so `body:ward:4` pays (ward bodies' purse
  payments silently failed before).
- *Reasons and lines.* `cardHistory` keeps an `ask` for question-style cards
  ("Which first?"), and chronicle lines and approval reasons never quote such
  a title.
- *Notices.* One major for the season ("Budget season: 11 bodies bring their
  budgets"), which opens its page; budget cards never raise per-card request
  notices; your answers and the year's lapses do not pass as minors; a body's
  own spending ("The Health Board began: …") does.
- *UI.* The Council gains a Budget season page after the Town Council while
  cards are open (the Town Council's page leaves budgets out). Budget cards
  (budget.js) show the lines with strike toggles, Approve, Trim to 90/75/half,
  Same as last year, and Refuse; the side shows the season (asked against
  room, the chest, Approve the rest, Trim all to fit, and every body's ask);
  on phones a strip over the cards does the same. A body's page shows "Its
  budget"; the Town Council's purse section becomes "This year's budgets".
- *Fixtures.* The town fixture is cached like the city's
  (src/sim/fixtures/town.json, grown with the previous economy so the tests
  read the same town), and the tests that read its incidental layout take
  what they need instead (tests/town-helpers.js). The stand-in council
  answers each season with "Trim all to fit".

**Step 5: advisers in the sim**
- New src/sim/advisors.js:
  - `drawSlate`, `hire`, `dismiss`, `advise`, `applyDue`, `advisersYearly`,
    `standingOf`;
  - beliefs from households, policies and slice answers.
- src/sim/households.js (`pastTrade` in `assignTrade`).
- src/sim/docket.js:
  - `addCard` → `advise` after `budgetCovers`;
  - `docketMonthly` → `applyDue`;
  - `record` adds `advisedBy`;
  - `rule()` with `by` an adviser.
- src/sim/policies.js (`adoptPolicy` `by` already free-form; nothing to do).
- src/sim/governance.js:
  - init and restore;
  - year hook;
  - actions `hireAdviser`, `dismissAdviser`, `setAdviserMode`, `letStand`,
    `redrawSlate`.
- src/sim/index.js, src/ui/bridge.js, src/sim/view.js (`selectAdvisers`;
  `card.advice` in `cardView`; `unlocks.advisers`).
- New tests/sim-advisors.test.js:
  - same seed → same slate;
  - the scorer is pure and its rationale names the top terms;
  - a staged answer applies at `dueMonth` and an override is counted;
  - dismissal withdraws staged answers;
  - salaries conserve money;
  - a household leaving vacates the seat.

**Step 6: advisers UI**
- New src/ui/components/advisers.js (the page: seats, adviser cards, slate).
- src/ui/components/card.js (advice banner, Let it stand / Change).
- src/ui/components/council.js (index entry).
- src/ui/app.js (notices, phone chip).
- CSS, stubs, browser test.

**Step 7: advisers vet budgets**
- src/sim/advisors.js (budget scoring).
- src/sim/budgets.js (staged budget answers; trim depth from the senior
  adviser).
- UI: the season summary's adviser line.
- Tests.

**Step 8: cleanup and docs**
- Remove `setDelegated`, `delegated`, `delegateCap`, `canDelegate`, and the
  `delegation` / `standingOrders` unlocks.
- Move `standingOrderFor` to advisers (instructions, for later) or delete it.
- Files: src/sim/institutions.js, docket.js, view.js, governance.js, index.js;
  src/ui/bridge.js; src/ui/dev/stub-*.js; tests/sim-governance.test.js:176
  and :898; tests/sim-opinion.test.js:102.
- Update docs/design/design-systems.md §3 and §9.1–9.2,
  docs/design/contract.md §5, and HANDOFF.md.

**As built (steps 5–8).** Where the build differs from the plan above:

- *Bench and seats.* `advisersReady`: City, 7 sitting bodies and one budget
  season paid (`governance.budgets.seasons`, new); the unlock then stays.
  Seats open as §4.1 says (second at 10 bodies or Metropolis, third at
  Metropolis with 10). Every seat, not only the first, takes its area at the
  hire, among the areas no other seat holds. Areas come from `areaOf`
  (the tag rule in §4.1), pinned by a test.
- *Candidates* are drawn as §4.2 (hash-seeded, no rng): the pool's standing
  score is wealth band, trade, years in town and a small hash; beliefs from
  trade, the trade's rule reactions (authority), a hash jitter, the town's
  traits, faith band and savings. The salary is 1.5–2.5% of the fiscal base
  (more for clerks and gentry and for pet issues), ×0.9–1.1 by hash, paid
  monthly to the household (`adviser-salary`; severance uses it too). A slate
  depends on the moment it is drawn (wealth bands move at the year's turn).
- *Answers.* `advise` is the §4.4 scorer over the card's options, reading the
  factions' local stances (`localStances`, nothing queued). Turning a plan
  down, the reasons are the two terms that weigh most against doing it.
  Budgets (§4.7): over the season's room, a trim to fit at the same factor
  "Trim all to fit" uses; else a careful adviser (thrift ≥ 0.4) trims to 90%,
  a wary one (body lean < −0.4) to 75%, the rest approve. Budget cards are
  advised once the whole season is on the table.
- *Staging.* A card the adviser will answer surfaces at once, outside the
  session caps, with `card.advice = {adviserId, option, factor?, rationale,
  month, dueMonth, act}`; `act: false` is a recommendation only (Advise only,
  events, petitions, ask-first plans, and per mode as §4.4's table). Due at
  the first quarterly session three months on (one month for a Blunt
  adviser), it is applied in `docketMonthly` through `rule(…, {adviser})` or
  `answerBudget(…, {adviser})`: rules are enacted `by: 'adviser:<id>'`,
  chronicle lines name the adviser, and `cardHistory` keeps `advisedBy` (and
  `overruled` when you chose otherwise). Let it stand applies now; any other
  answer you give counts as overruling. Tempers: Tactful softens a refusal's
  patience loss by 30%; Blunt answers in a month; Shrewd recovers 5% of a
  plan's cost from outside (`adviser-haggle`); Steady never resigns.
- *Plans.* An area's adviser lifts a plan it would back by 0.1 need when a
  body drafts its budget (`planBoost`), so plans it favours make budgets more
  often.
- *Departures.* Yearly: a household gone, or 20 years served, empties the
  seat; an adviser resigns when you changed 60% or more of at least three
  answers in the year, or over half and you enacted a rule against their pet
  issue. Dismissal pays half a year's salary, withdraws their staged answers,
  bars them ten years, sours their trade by 0.03 if their Standing was 60 or
  more, and draws a new slate. Standing is the §4.5 score.
- *Notices.* One major when the bench opens or a seat's slate is ready
  (naming who left, if anyone); cards an adviser will answer raise no request
  notice (they wait on the Advisers page); an applied answer passes as a
  minor notice only while the Council is closed.
- *UI.* An Advisers page in the Council after Budget season: each seat's
  adviser card (background, belief chips, the four scales, Standing with its
  sparkline, answered, overruled %, salary, mode, what waits for review,
  recent answers, Dismiss with a confirm) or the slate (area chips, Hire, See
  others once a year), above the cards waiting for review. The banner on an
  advised card (card.js and budget.js): who, what, why, when, Let it stand,
  Change answer. The season summary lists each adviser's answers.
- *Step 8.* Removed: `setDelegated`, `canDelegate`, `setStandingOrder`,
  `standingOrderFor`, `selfResolve`, `settleByOrder`, the `delegated`,
  `delegateCap` and `standingOrders` fields (dropped from old saves on
  restore), the view fields and the `delegation` / `standingOrders` unlocks,
  the report-card condition (yearly reports are for budget bodies), the
  "runs its own affairs" lines and chips, and the stubs. Old histories'
  `delegated` outcomes still read as approvals. Borough's arrival line now
  says bodies work to yearly budgets.
- *Not built:* adviser instructions (§4.9), the narrator memo and an
  `adviser_answer` decision kind (step 9).

**Optional step 9: adviser prose**
- Narrator memo (`setAdviceProse`) via src/narrator-client.js and a
  narrative-schema facts kind, or a decision kind `adviser_answer` in
  src/sim/decisions/kinds.js and src/decision-kinds.js (server-validated).

---

## 10. Risks

- **Automation hides what matters.**
  - Self-funding must never touch rules, demolitions or unpopular plans
    (`askFirst`, the opinion check).
  - Staged adviser answers wait a season.
  - Minor notices and yearly reports keep it visible.
  - Watch the "cards per year" target from design-systems §9.1.
- **Treasury drain.** Bodies that always ask more could squeeze rule upkeep.
  The guards are the per-body cap (12% of fiscal base), room in the season
  summary, scaled payment at rollover, receivership taking over the season,
  and underspend lowering the next ask.
- **Money conservation.** Every new flow goes through `pay` / `payBuilders`:
  grants, returns, salaries, severance and top-ups. Add each one to the
  `totalMoney` invariant test.
- **Determinism drift.** Avoid rng entirely. Advice application order follows
  the docket array, which is itself deterministic. Re-run the golden and
  fixture tests after each step. Step 0 and the removal of the `delegate`
  option change outcomes on purpose.
- **Card-kind ripple.** The new `budget` kind touches every kind switch:
  - `PRIORITY` (docket.js:226), `KIND_ORDER` (view.js:160), `URGENT` (docket.js:31),
    `ASKED_KINDS` (view.js:92);
  - `cardAdded` (scheduler.js:169): budget cards should *not* get faction
    stance questions, or use the body's faction only;
  - `KIND_LABEL` (card.js:8) and narrator option-key validation
    (tests/narrator.test.js:410);
  - `pruneStale` and `subjects`: give budget cards a subject
    `budget:<body>:<year>`.
- **Old purse paths overlapping new ones.** For annual bodies, all of these
  must be off: `balancePurses`, `fundInstitutions`, `RUNNING_SHARE`, and
  `{budget: x}` effects as shares. Test a body that turns annual mid-game.
- **Advisers feel arbitrary.** Keep the scorer linear and show the two top
  terms. Clamp the opinion term so advisers aren't just "do what's popular".
  Make pet issues weigh enough to give each one character.
- **Phone density.** Budget cards have the most text in the game. Collapse
  lines by default, and use the sticky season strip and the pager.
- **Save size.** History caps (30 per body, 60 per adviser, 200 approval
  years) add about 50 KB at most to a 5 MB save.
- **Works cache.** `draftBudget` must not call `fetchKind` for stale kinds
  (institutions.js:55), because that would call sim-world in a burst at season
  open. Read the cache only; a plan without a fresh candidate is simply left
  out.

---

## 11. Decisions

The open questions were answered in October 2026, all as recommended. They are
kept here with the answer that was chosen.

1. **How are advisers organised?** *Decided: two or three seats by area*,
   opening as the town grows, each with its own adviser. Areas are matched by
   body tags, not fixed lists (see 4.1). Rejected: one chief adviser over
   every body; one adviser per body.
2. **How finely can you edit a budget?** *Decided: whole-budget answers*
   (approve; trim to 90, 75 or 50%; same as last year; refuse) *plus striking
   individual plan lines.* Rejected: editing every line's amount.
3. **What may a budgeted body do without asking you?** *Decided: its approved
   plan lines, plus small unplanned things under 15% of its grant.* Rules,
   demolitions (`askFirst`) and unpopular plans always come to you.
4. **How much freedom do advisers have?** *Decided: they act, and you can
   overrule within a review window* (one season; one month for a Blunt
   adviser), *with a per-seat Advise only / Routine / All setting.* Adviser
   choices do not use the model decision bus in version 1; the narrator may
   write memo prose only.
5. **Does approval change anything?** *Decided: information only in version
   1.* The mild feedback in 5.6 (low approval feeds petitions and unrest, high
   approval helps body patience) is a later phase, to be judged in real towns
   first.
6. **When do the features unlock?** *Decided: as proposed.* Approval is
   recorded from year 0 and shown at Borough; budgets at Borough with 5+
   bodies, at the next autumn; advisers at City with 7+ bodies after one
   budget season.
7. **What happens to a budget left unanswered by year end?** *Decided: same as
   last year.*
