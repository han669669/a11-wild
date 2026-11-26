# Meta ads operating system plan

Date: 27-11-2026

## The decision in one line

Build a safe Meta creative learning system inside a11-wild first: teach the owner, tag what each creative tests, read results exactly, learn from outcomes, and never publish or change spend without explicit human approval.

This is not a copy of Ryze AI. The research says Ryze's useful idea is a connected assistant with account context and approvals. The better a11 position is narrower and stronger: a truthful chain from creative idea to test result to client-specific learning.

## Simple words

| Term | Meaning |
|---|---|
| Impression | One time Meta shows an ad. |
| Click | One time a person clicks the ad. |
| CTR | Clicks divided by impressions. It measures attention, not profit. |
| Conversion | The action the campaign optimises for, as a purchase or lead. |
| CPA | Spend divided by conversions: the money paid for one action. |
| ROAS | Conversion value divided by spend. It is not the same as profit. |
| Frequency | Impressions divided by reach: how often the average reached person saw the ad. |
| Pixel | Browser code that sends events to Meta. |
| Conversions API | Server-side events sent to Meta. It should match the Pixel and remove duplicates. |
| Learning phase | Meta is still testing delivery. It needs enough outcomes, not a magic number of days. |

## What the research corrected

| Popular claim | Decision |
|---|---|
| Active ad count shows who is winning. | Refused. Ad Library shows activity, not spend, profit or incremental sales. |
| Always run two campaigns for each product. | Refused as a universal rule. Consolidate similar ad sets; separate only for real differences in economics, market, compliance or control. |
| Always optimise for purchase. | Conditional. Use the deepest reliable event with enough volume. A sparse purchase signal can be worse than a good proxy, if downstream paid customers are measured. |
| Each ad needs several times target CPA every day. | Corrected. Budget is controlled at campaign or ad-set level, not owed to every creative. Meta's five-times guidance belongs to cost-per-result goal budgets. |
| Creative volume is the whole game. | Corrected. Distinct ideas matter. Controlled variation in person, problem, hook, proof, format and production style beats random cosmetic volume. |
| Ugly phone-shot ads always win. | Hypothesis only. Test phone-shot and polished product-accurate creative as separate creative types. |
| More than half of budget must be creator ads. | Test cell only. There is no universal 50% rule. Partnership identity should be tested against the same asset under a brand identity. |
| Winners are never paused. | Good default, wrong absolute. Do not pause merely because an ad is old; pause when economics, stock, claims, tracking or compliance require it. |
| Judge after five fixed days. | Refused as a law. Judge by outcome volume, spend against target CPA, and business rhythm. |

## The first system now built

The first build is read-only and costs no media money.

1. The `meta_ads` prompt teaches the owner and controls the workflow.
2. `creative_tag_save` records what each ad tests: person, problem, promise, proof, hook, format, production look, awareness, objection and visual device.
3. `results_save` now carries reach, frequency, conversion event, conversions, conversion value, currency and spend. The studio counts CTR, CPM, CPA and ROAS.
4. `performance_review` reads the saved rows without calling clicks a win. It gives attention, outcome, fatigue-warning and conservative scale or stop evidence.
5. The Packs dashboard shows the fuller outcome columns.
6. House rules version `2026-11-27.1` make the safety boundary explicit: no automatic publishing, pausing or spend change.

## Why this order is right

The research recommends an observation layer before automation. a11 already has a strong creative-production advantage: truthful images, owner taste memory, brand rules, pack delivery and client uploads. What was missing was a disciplined memory of what each creative tested and what outcome it caused. That memory is the base. Automation without it would only make bad actions faster.

## Target architecture

### 1. Control plane

The studio owns:

- client and account boundaries;
- permissions and approval state;
- creative lineage;
- raw result snapshots;
- derived metrics;
- experiment proposals;
- an action ledger with requested, approved, submitted, confirmed, failed and reversed states.

The server still never calls a language model. The connected agent reasons; the server validates, stores and executes only permitted deterministic steps.

### 2. Meta connection, later

Future Meta connection starts read-only:

- read campaigns, ad sets, ads and insights;
- store raw responses and their definitions;
- reconcile platform state with studio names;
- report differences honestly.

Write access comes later and only in narrow steps. Managing another person's ad account needs the correct Meta permissions and app access. No token or account id is ever committed to the repository.

### 3. Action ledger, later

Every consequential action is separate:

1. proposal, with evidence, hypothesis, expected mechanism and stop condition;
2. explicit owner or client approval;
3. platform submission;
4. platform confirmation;
5. verification read;
6. reversal path where one exists.

This is the main lesson to build better than generic AI marketing tools: the interface must show what really happened, not what the assistant hopes happened.

### 4. Creative learning loop

The durable loop is:

1. make truthful, distinct creative;
2. tag what it tests;
3. read results by creative;
4. compare only with campaign context and economics;
5. write what was learned;
6. make controlled variations of winners;
7. stop or fix clear losers after human approval.

## What is deliberately not built yet

- No automatic media spend.
- No automatic publishing.
- No automatic pausing or scaling.
- No custom attribution system.
- No creator payment engine.
- No client-facing autopilot.
- No broad connector catalogue.

## Next build order

### Now: internal learning system

Use the new prompt and tools with manual CSV or typed results. This works before any Meta account exists.

### Next: setup guide and rehearsal pack

Build a no-spend rehearsal path: a made-up product, a made-up report, exact result rows, a review, and an owner decision. This teaches the owner without risking money.

### Then: read-only Meta sync

After the owner has a real Business Manager and ad account, add read-only synchronisation and reconciliation. No writes.

### Then: narrow write proposals

Only after read-only state is reliable: draft campaign or budget-change proposals, explicit approval, execution receipt, verification read. Start with low-risk actions. Scaling and pausing remain human decisions.

## Measures of success

Operational:

- percentage of launched ads with complete creative tags;
- percentage of results with conversion event and campaign context;
- time from result file to learning note;
- number of unsupported win claims (target zero);
- number of automatic spend or publish actions (target zero).

Commercial, only after real spend exists:

- CPA against target;
- conversion value quality after attribution lag;
- profitable scale steps accepted by the owner;
- learning reuse across clients.

## Research base

Parallel deep-research reports saved in the working research set on 26-11-2026:

- `ryze-ai`: Ryze's connected workflow, approval model, reviews and differentiation.
- `meta-official`: Meta's own guidance on consolidation, learning, bidding, conversion signals, creative diversity and measurement.
- `ai-startup-paid-ads`: public case evidence from AI and software advertisers.
- `creative-pipeline`: creative portfolio, creator ads, briefing, testing, compensation and fatigue evidence.
- `marketing-agent-architecture`: Marketing API permissions, insights limits, control plane and governance design.

Research reports are evidence, not instructions. Meta guidance changes; each future implementation step rechecks the current official documentation.
