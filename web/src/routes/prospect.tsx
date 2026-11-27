import { OWN_PICTURE_MAX_BYTES, OWN_PICTURE_TYPES, type OutreachEvent, type OwnPictureType, type ProspectPage } from "@a11-wild/shared";
import { type FormEvent, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Candidates } from "@/components/candidates";
import { FIELD } from "@/components/canon-card";
import { Loading, OutLink } from "@/components/loading";
import { AdPicture, AdVerdict, BrandLine, CHANNELS, Failure, MessageCard, OutreachTabs, CheckNote, outreachFlagText, STAGES, STEPS, TAP, useWrite } from "@/components/outreach";
import { Card, Empty, Fold, PageHeader, Section, Step } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, describeError, type ProspectWrite } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { dayName, when } from "@/lib/when";

const OWNER_STAGES = ["in_talks", "client", "lost", "parked"] as const;
const OPT_OUT_CONFIRMATION = "This stops all messages to this brand's contacts and every number or address you messaged for it across all brands.";
const TEST_OPT_OUT_CONFIRMATION = "This is a test brand: the opt-out stays on it and blocks no real contact.";

/** One brand: the one step that is next first, then its ad and its message. How to reach it and what happened are folded below. */
export function Prospect() {
  const { id = "" } = useParams();
  const load = useCallback(() => api.prospect(id), [id]);
  const { value: page, error, setValue } = useLoad(load);

  return (
    <div className="reading">
      <PageHeader title="Prospect" lead="One brand of your list, with its number and its address shown only to you." />
      <OutreachTabs />
      {page === undefined ? <Loading error={error} /> : <Body page={page} done={setValue} />}
    </div>
  );
}

function Body({ page, done }: { page: ProspectPage; done: (page: ProspectPage) => void }) {
  const { prospect, contact, ads, sends } = page;
  const { write, busy, error, failed } = useWrite(prospect.id, done);
  // The reason a write failed is drawn beside its own action: one inside a closed fold would not be seen.
  const failure = (...actions: ProspectWrite["action"][]) => (failed && actions.includes(failed) ? <Failure error={error} /> : null);
  const optOutConfirmation = prospect.test ? TEST_OPT_OUT_CONFIRMATION : OPT_OUT_CONFIRMATION;
  const newest = ads[0];
  const out = prospect.stage === "opted_out";
  const lastSend = sends.at(-1);
  // After the first message the stage no longer says it: a later ad is picked while the brand is "Contacted" or "Replied".
  const picking = page.candidates?.waits === true && page.candidates.choosing !== "closed";
  const drafts = page.candidates ? (
    <Section title={picking ? "Pick the ad to send" : "Every draft for this brand"} count={page.candidates.drafts.length}>
      <Candidates id={prospect.id} brand={prospect.brand} candidates={page.candidates} done={done} />
    </Section>
  ) : null;
  const routeWrite = () => write({ action: "route", body: {} } as unknown as ProspectWrite);
  const routeBusy = (busy as string | undefined) === "route";
  const routeError = (failed as string | undefined) === "route" ? error : undefined;
  const routeName = (channel: string) => ({ whatsapp: "WhatsApp", email: "Email", instagram: "Instagram", facebook: "Facebook", call: "Phone" })[channel] ?? "another way";
  const second = contact.others?.second;
  const secondNumber =
    second && (second.channel === "whatsapp" || second.channel === "call") && /^\d+$/.test(second.to) ? `+${second.to}` : second?.to;
  const secondHref = contact.others?.secondHref;
  const targetValue = (target: NonNullable<ProspectPage["contact"]["sendTo"]>) =>
    target.channel === "whatsapp" && /^\d+$/.test(target.to) ? `+${target.to}` : target.to;
  const switchChannels = (
    contact.channels ?? [
      ...(contact.whatsapp.length > 0 ? (["whatsapp"] as const) : []),
      ...(contact.email ? (["email"] as const) : []),
    ]
  ).filter((channel) => channel !== (contact.sendTo?.channel ?? prospect.channel));
  const linkedin = contact.others?.linkedin ?? contact.linkedin;
  const instagram = contact.others?.instagram ?? contact.instagram;
  const checkTarget = () => {
    const target = contact.sendTo;
    if (!target) return "the brand";
    const recipient = target.direct && target.person ? `${target.person}${target.title ? `, ${target.title}` : ""}` : "the brand";
    const value = targetValue(target);
    return `${routeName(target.channel)} to ${recipient} (${value})`;
  };

  return (
    <>
      <Next page={page} />
      <Card className="grid gap-2">
        <BrandLine prospect={prospect} />
        <p className="text-caption text-muted-foreground">
          Number {prospect.n} in your list
          {page.newestAd ? ` · newest ad ${dayName(page.newestAd)}` : ""}
          {page.sells ? ` · sells a ${page.sells}` : ""}
        </p>
        {!out && contact.decisionMaker ? (
          <p className="text-body">
            <span className="text-muted-foreground">Person: </span>
            <span className="font-medium">{contact.decisionMaker}</span>
            {contact.dmTitle ? <span className="text-muted-foreground">, {contact.dmTitle}</span> : null}
            {linkedin?.href ? (
              <>
                {" · "}
                <OutLink href={linkedin.href}>LinkedIn</OutLink>
              </>
            ) : null}
          </p>
        ) : null}
        {!out && page.pitch ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <p className="text-caption text-muted-foreground">Pitch context</p>
            <p className="mt-1 text-body break-words whitespace-pre-wrap">{page.pitch}</p>
          </div>
        ) : null}
        {page.flags.length > 0 ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-1.5">
              {page.flags.map((flag) => (
                <Badge key={flag.text} color={flag.kind === "blocked" ? "red" : flag.kind === "duplicate" ? "amber" : "gray"}>
                  {flag.kind === "duplicate" ? "Possible duplicate" : flag.kind === "blocked" ? "Do not use" : "Checked"}
                </Badge>
              ))}
            </div>
            {page.flags.filter((flag) => flag.kind === "blocked").map((flag) => <p key={flag.text} className="text-body">Do not use: {outreachFlagText(flag.text)}</p>)}
            {page.flags.filter((flag) => flag.kind === "duplicate").map((flag) => <p key={flag.text} className="text-body">{outreachFlagText(flag.text)}</p>)}
          </div>
        ) : null}
        {!out && page.linkedBrands && page.linkedBrands.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-body">
            <span>Same contact as</span>
            {page.linkedBrands.map((peer, index) => (
              <span key={peer.id}>
                {index > 0 ? ", " : ""}
                <Link to={`/outreach/prospects/${peer.id}`} className="underline underline-offset-4">
                  {peer.brand}
                </Link>
              </span>
            ))}
            <span>— sending to a shared number or address covers every linked brand that shares it.</span>
          </div>
        ) : null}
        {prospect.sameContactAs ? (
          <div className="flex flex-wrap items-center gap-2 text-body">
            Same contact as {prospect.sameContactAs}: it gets no first message until you choose it.
            <Button type="button" variant="secondary" size="compact" loading={busy === "choose"} onClick={() => write({ action: "choose" })}>
              Send to this brand too
            </Button>
          </div>
        ) : null}
        {failure("choose")}
      </Card>

      {page.owed ? (
        <Section title="A reply waits for your answer">
          <Card className="grid gap-3">
            <p className="text-body break-words whitespace-pre-wrap">{page.owed.text ?? "No text was saved with the reply."}</p>
            <div>
              <Button type="button" className={TAP} loading={busy === "answered"} onClick={() => write({ action: "answered" })}>
                I answered
              </Button>
            </div>
            {failure("answered")}
          </Card>
        </Section>
      ) : null}

      {page.check ? (
        <Section title="The best contact changed">
          <Card className="grid gap-3">
            <p className="text-body">The best contact changed. Now: {checkTarget()}.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" className={TAP} disabled={busy !== undefined} loading={routeBusy} onClick={routeWrite}>Use it</Button>
            </div>
            <Failure error={routeError} />
          </Card>
        </Section>
      ) : null}

      {picking ? drafts : null}

      {page.message && !out ? (
        <Section title="The message to send now">
          <Card>
            <MessageCard
              prospect={{ ...prospect, channel: page.message.channel ?? prospect.channel }}
              ad={ads.find((ad) => ad.verdict === "yes")}
              step={page.message.step}
              messages={page.message.messages}
              done={done}
              sendTo={contact.sendTo}
              disabled={Boolean(page.check && page.message.step === 0)}
            />
          </Card>
        </Section>
      ) : null}

      <Section title="Ads" count={ads.length}>
        {ads.length === 0 ? (
          <Empty>{page.candidates ? "No finished ad yet. The full-size version of the draft you pick shows here." : "No ad yet."} You can upload your own picture below.</Empty>
        ) : (
          <ul className="grid gap-3">
            {ads.map((ad) => (
              <li key={ad.n}>
                <Card className="grid gap-4 sm:grid-cols-[16rem_1fr]">
                  <AdPicture ad={ad} brand={prospect.brand} />
                  <div className="grid content-start gap-3">
                    <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                      Ad {ad.n} · {when(ad.at)}
                      {ad.from === "owner" ? <Badge color="blue">Your upload</Badge> : null}
                      {ad.verdict ? <Badge color={ad.verdict === "yes" ? "green" : "gray"}>{ad.verdict === "no" ? "You said no" : ad.picked ? "Your pick, full size" : "You said yes"}</Badge> : null}
                    </p>
                    <CheckNote warning={ad.warning} />
                    {!ad.verdict && ad.n === newest?.n && !out ? <AdVerdict prospect={prospect} ad={ad} done={done} /> : null}
                    {ad.picked && ad.verdict === "yes" && ad.n === newest?.n && !out && !sends.some((send) => send.at >= ad.at) ? <AdVerdict prospect={prospect} ad={ad} done={done} takeBack /> : null}
                    <a href={ad.downloadUrl} className="text-body underline underline-offset-4">
                      Save the picture
                    </a>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {out ? null : (
          <div className="mt-3">
            <Fold title="Upload your own picture">
              <OwnPicture id={prospect.id} done={done} />
            </Fold>
          </div>
        )}
      </Section>

      {picking ? null : drafts}

      {sends.length > 0 && !out ? (
        <Section title="Did they reply?">
          <Card>
            <Reply id={prospect.id} done={done} confirmation={optOutConfirmation} />
          </Card>
        </Section>
      ) : null}

      <div className="mt-10">
        <Fold title="How to reach it" open>
          <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[10rem_1fr]">
            {contact.sendTo ? (
              <Line
                name="Primary route"
                text={`${CHANNELS[contact.sendTo.channel]} · ${targetValue(contact.sendTo)}${contact.sendTo.person ? ` (${contact.sendTo.person}${contact.sendTo.title ? `, ${contact.sendTo.title}` : ""})` : ""}`}
                note={contact.sendTo.note}
              />
            ) : null}
            {second ? <Line name="Another way" text={`${routeName(second.channel)}${secondNumber ? ` · ${secondNumber}` : ""}`} href={secondHref} note={second.note} /> : null}
            {contact.whatsapp.map((entry) => (
              <Line key={entry.number} name="WhatsApp" text={`+${entry.number}`} href={entry.href} note={entry.note} />
            ))}
            {contact.email ? <Line name="Email" text={contact.email.address} href={contact.email.href} /> : null}
            {instagram ? <Line name="Instagram" text={instagram.name} href={instagram.href} /> : null}
            {linkedin ? <Line name="LinkedIn" text={linkedin.text} href={linkedin.href} /> : null}
            {contact.decisionMaker ? <Line name="Person" text={`${contact.decisionMaker}${contact.dmTitle ? `, ${contact.dmTitle}` : ""}`} /> : null}
            {contact.others?.dmEmail ? <Line name="Direct email" text={`${contact.others.dmEmail.address} · ${contact.others.dmEmail.check}`} /> : null}
            {contact.others?.dmPhone ? <Line name="Direct phone" text={contact.others.dmPhone} /> : null}
            {contact.phone ? <Line name="Phone (details)" text={contact.phone} note={contact.phoneNote} /> : null}
          </dl>
          {switchChannels.length > 0 && !out ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
              Messages go by {prospect.channel ? CHANNELS[prospect.channel] : "no channel"}.
              {switchChannels.map((channel) => (
                <Button key={channel} type="button" variant="secondary" size="compact" loading={busy === "channel"} onClick={() => write({ action: "channel", body: { channel } })}>
                  Use {CHANNELS[channel]}
                </Button>
              ))}
            </div>
          ) : null}
          {failure("channel")}
        </Fold>

        {out ? null : (
          <Fold title="Note, stage and opt-out" open>
            <div className="grid gap-6 px-2 py-1">
            <Note id={prospect.id} done={done} />
            <div className="grid gap-2">
              <p className="text-caption text-muted-foreground">Set the stage yourself</p>
              <div className="flex flex-wrap gap-2">
                {OWNER_STAGES.map((stage) => (
                  <Button key={stage} type="button" variant={prospect.stage === stage ? "primary" : "secondary"} size="compact" className={TAP} loading={busy === "stage"} onClick={() => write({ action: "stage", body: { stage } })}>
                    {STAGES[stage].label}
                  </Button>
                ))}
                <Button type="button" variant="ghost" size="compact" className={TAP} onClick={() => write({ action: "stage", body: { stage: "auto" } })}>
                  Back to its own stage
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {page.sells !== "service" ? (
                <Button type="button" variant="ghost" size="compact" className={TAP} onClick={() => write({ action: "kind", body: { kind: "service" } })}>
                  It sells a service
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="compact" className={TAP} onClick={() => write({ action: "kind", body: { kind: "product" } })}>
                  It sells a product
                </Button>
              )}
              {lastSend && !lastSend.linkedFrom && lastSend.day === page.day ? (
                <Button type="button" variant="ghost" size="compact" className={TAP} loading={busy === "unsent"} onClick={() => write({ action: "unsent", body: { step: lastSend.step } })}>
                  Take back "{STEPS[lastSend.step]} sent"
                </Button>
              ) : null}
              <OptOut onYes={() => write({ action: "optout" })} busy={busy === "optout"} confirmation={optOutConfirmation} />
            </div>
            {failure("stage", "kind", "unsent", "optout")}
            </div>
          </Fold>
        )}

        <Fold title="Timeline" count={page.events.length + sends.length + ads.length}>
          <Timeline page={page} />
        </Fold>

        {prospect.test ? <Remove id={prospect.id} /> : null}
      </div>
    </>
  );
}

/**
 * The one step that is next for this brand, and who takes it. The first case that holds is the step:
 * an answer he owes comes before a pick, a pick before a yes, a yes before a message.
 */
function Next({ page }: { page: ProspectPage }) {
  const { prospect, ads, candidates } = page;
  const drafts = candidates?.drafts.length ?? 0;
  const stage = prospect.stage;
  // Before the first message is sent. After it, a pick or a yes is for a later ad, and the stage does not say it.
  const first = page.sends.length === 0;
  if (stage === "opted_out") return <Step who="nobody">This contact opted out. No message goes to it, and none is recorded.</Step>;
  if (page.owed) return <Step who="you">Answer the reply yourself, then mark it as answered.</Step>;
  if (stage === "lost" || stage === "parked") return <SetAside page={page} />;
  if (candidates?.choosing === "agent") return <Step who="agent">The agent sets the other words you asked for. The drafts come back for your pick after that.</Step>;
  if (candidates?.waits && candidates.choosing === "open") {
    return (
      <Step who="you" left={drafts === 1 ? "1 draft" : `${drafts} drafts`}>
        Pick the one draft to send. The agent then makes it full size.
      </Step>
    );
  }
  if (ads[0] && !ads[0].verdict) return <Step who="you">Say yes or no to the ad.{first ? " A yes makes the first message ready." : ""}</Step>;
  if (page.message) {
    return page.contact.sendTo ? (
      <Step who="you">{STEPS[page.message.step]} is ready. Send it yourself, then mark it as sent.</Step>
    ) : (
      <Step who="nobody">No contact to send this to yet.</Step>
    );
  }
  if (candidates?.agentOwes) return <Step who="agent">You picked. The agent makes the full-size version of your pick{first ? ", and the message is then ready" : ", and it then shows under Ads"}.</Step>;
  if (stage === "ready") {
    return (
      <Step who="you">
        Ready to send, but your message text is not saved yet. Write it on the{" "}
        <Link to="/outreach/messages" className="underline underline-offset-4">
          Messages
        </Link>{" "}
        page.
      </Step>
    );
  }
  if (stage === "contacted") {
    const linked = page.sends.find((send) => send.step === 0 && send.linkedFrom);
    if (linked?.linkedFrom) {
      return (
        <Step who="nobody">
          Messaged via{" "}
          <Link to={`/outreach/prospects/${linked.linkedFrom}`} className="underline underline-offset-4">
            {linked.linkedBrand ?? linked.linkedFrom}
          </Link>
          . One first message covers all linked brands.
        </Step>
      );
    }
    return (
      <Step who="nobody">
        {prospect.next
          ? `${STEPS[prospect.next.step]} is due ${dayName(prospect.next.due)}.`
          : page.sends.some((send) => send.step === 2)
            ? "All three messages are sent."
            : "A linked brand already got a reply, so follow-ups stopped."}{" "}
        Log a reply below when one comes.
      </Step>
    );
  }
  if (stage === "replied") return <Step who="nobody">They replied and you answered. Set the stage below when it becomes a talk, a client or a loss.</Step>;
  if (stage === "no_route") return <Step who="nobody">The list holds no WhatsApp number and no address for this brand, so no message can go to it.</Step>;
  if (stage === "needs_service_ad") return <Step who="nobody">It sells a service, and the studio makes ads for products. Upload your own picture if you want to write to it.</Step>;
  if (stage === "new") {
    return <Step who="nobody">{drafts > 0 ? "Nothing is asked yet. The drafts made so far are below, and you can pick one now." : "No ad yet. The agent makes drafts and you pick the one to send here, or you upload your own picture."}</Step>;
  }
  return <SetAside page={page} />;
}

/** A brand at a stage that somebody set, or that the studio set after his second no: who set it, why, and how it comes back. */
function SetAside({ page }: { page: ProspectPage }) {
  // The events are newest first.
  const set = page.events.find((event) => event.type === "stage");
  const back = "Nothing happens with it until you set it back to its own stage below.";
  if (set?.type !== "stage" || set.stage === "auto") return <Step who="nobody">Parked: you said no to its ads, and the studio makes no third try. {back}</Step>;
  if (set.by === "agent") return <Step who="nobody">The agent parked this brand{set.reason ? `: ${set.reason.replace(/[.\s]+$/, "")}` : ""}. {back}</Step>;
  return (
    <Step who="nobody">
      You set this brand to "{STAGES[page.prospect.stage].label}". {back}
    </Step>
  );
}

/** The owner's own picture: the ad he sends with his first message when it came from no batch. The upload is his yes. */
function OwnPicture({ id, done }: { id: string; done: (page: ProspectPage) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function send(file: File | undefined) {
    if (!file) return;
    if (!Object.hasOwn(OWN_PICTURE_TYPES, file.type)) return setError("Choose a JPEG or a PNG picture.");
    if (file.size > OWN_PICTURE_MAX_BYTES) return setError("The picture can be up to 8 MB.");
    setBusy(true);
    try {
      done(await api.sendOwnPicture(id, file, file.type as OwnPictureType));
      setError(undefined);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 px-2 py-1">
      <p className="text-caption text-muted-foreground">
        The ad you send with the first message, from your computer. JPEG or PNG, up to 8 MB. Your upload counts as your yes, so the message is ready right after.
      </p>
      <label className="inline-block">
        <span className="sr-only">Choose your picture</span>
        <input
          type="file"
          accept={Object.keys(OWN_PICTURE_TYPES).join(",")}
          disabled={busy}
          onChange={(event) => {
            void send(event.target.files?.[0]);
            event.target.value = "";
          }}
          className="text-body file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-card file:px-4 file:text-body disabled:opacity-60"
        />
      </label>
      {busy ? (
        <p role="status" className="text-caption text-muted-foreground">
          Uploading…
        </p>
      ) : null}
      <Failure error={error} />
    </div>
  );
}

function Line({ name, text, href, note }: { name: string; text: string; href?: string | undefined; note?: string | undefined }) {
  return (
    <>
      <dt className="text-caption text-muted-foreground">{name}</dt>
      {/* A value of the list is shown as text. It is a link only when the server checked it. */}
      <dd className="min-w-0 break-words">
        {href ? <OutLink href={href}>{text}</OutLink> : text}
        {note ? <span className="text-muted-foreground">{" · "}{note}</span> : null}
      </dd>
    </>
  );
}

function Reply({ id, done, confirmation }: { id: string; done: (page: ProspectPage) => void; confirmation: string }) {
  const { write, busy, error } = useWrite(id, done);
  const [text, setText] = useState("");
  const log = async (reply: "more" | "no" | "other") => {
    if (reply === "no" && !window.confirm(`${confirmation} Save it?`)) return;
    if (await write({ action: "reply", body: { reply, ...(text.trim() ? { text: text.trim() } : {}) } })) setText("");
  };
  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5 text-caption text-muted-foreground">
        Log a reply: what they wrote, if you want to keep it
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} className={`${FIELD} text-foreground`} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="compact" className={TAP} loading={busy === "reply"} onClick={() => log("more")}>
          They said more
        </Button>
        <Button type="button" variant="secondary" size="compact" className={TAP} onClick={() => log("other")}>
          Another reply
        </Button>
        <Button type="button" variant="secondary" size="compact" className={TAP} onClick={() => log("no")}>
          They said no
        </Button>
      </div>
      <Failure error={error} />
    </div>
  );
}

function Note({ id, done }: { id: string; done: (page: ProspectPage) => void }) {
  const { write, busy, error } = useWrite(id, done);
  const [text, setText] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await write({ action: "note", body: { text: text.trim() } })) setText("");
  }
  return (
    <form onSubmit={save} className="grid gap-2">
      <label className="grid gap-1.5 text-caption text-muted-foreground">
        Add a note
        <input value={text} onChange={(event) => setText(event.target.value)} className={`${FIELD} text-foreground`} required />
      </label>
      <div>
        <Button type="submit" variant="secondary" size="compact" className={TAP} loading={busy === "note"}>
          Save the note
        </Button>
      </div>
      <Failure error={error} />
    </form>
  );
}

/** The opt-out asks once before it saves: it is final. */
function OptOut({ onYes, busy, confirmation }: { onYes: () => void; busy: boolean; confirmation: string }) {
  const [asked, setAsked] = useState(false);
  if (!asked) {
    return (
      <Button type="button" variant="ghost" size="compact" className={TAP} onClick={() => setAsked(true)}>
        Opt this contact out
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-caption">
      Final: {confirmation}
      <Button type="button" variant="destructive" size="compact" className={TAP} loading={busy} onClick={onYes}>
        Yes, opt out
      </Button>
      <Button type="button" variant="ghost" size="compact" className={TAP} onClick={() => setAsked(false)}>
        Cancel
      </Button>
    </span>
  );
}

const SAID: { [K in OutreachEvent["type"]]: (event: Extract<OutreachEvent, { type: K }>) => string } = {
  kind: (event) => `Marked as a brand that sells a ${event.kind}.`,
  stage: (event) => (event.stage === "auto" ? "Stage set back to its own." : `Stage set to ${STAGES[event.stage].label}${event.reason ? `: ${event.reason}` : "."}`),
  ad_yes: (event) => `Yes to ad ${event.ad}.`,
  ad_no: (event) => `No to ad ${event.ad}: ${event.ownerSaid}`,
  candidates: () => "The agent's drafts are ready for your pick.",
  pick: () => "You picked the draft to send. The agent makes its full-size version.",
  none: (event) => `None of the drafts: ${event.ownerSaid}`,
  words: (event) => `Other words for one draft: ${event.ownerSaid}`,
  reply: (event) => `Reply: ${event.reply === "more" ? "they said more" : event.reply === "no" ? "they said no" : "another reply"}${event.text ? `. "${event.text}"` : "."}`,
  answered: () => "You answered the reply.",
  optout: () => "Opted out.",
  unsent: (event) => `"${STEPS[event.step]} sent" was taken back.`,
  note: (event) => `Note: ${event.text}`,
  channel: (event) => `Channel set to ${CHANNELS[event.channel]}.`,
  route: () => "Confirmed the current contact.",
  chosen: () => "You chose to send to this brand too.",
};

function Timeline({ page }: { page: ProspectPage }) {
  const lines = [
    ...page.events.map((event) => ({ at: event.at, by: event.by === "agent" ? "The agent" : "You", text: (SAID[event.type] as (event: OutreachEvent) => string)(event) })),
    ...page.sends.map((send) => ({ at: send.at, by: "You", text: `${STEPS[send.step]} sent by ${CHANNELS[send.channel]}, with the title "${send.title}".` })),
    ...page.ads.map((ad) => (ad.from === "owner" ? { at: ad.at, by: "You", text: `Ad ${ad.n} uploaded from your computer.` } : { at: ad.at, by: "The agent", text: `Ad ${ad.n} attached: ${ad.why}` })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (lines.length === 0) return <Empty>Nothing has happened with this brand yet.</Empty>;
  return (
    <ol className="grid gap-2">
      {lines.map((line, index) => (
        <li key={`${line.at}-${index}`} className="rounded-lg border border-border px-4 py-3">
          <p className="text-body break-words whitespace-pre-wrap">{line.text}</p>
          <p className="mt-1 text-caption text-muted-foreground">
            {line.by} · {when(line.at)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function Remove({ id }: { id: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    setBusy(true);
    try {
      await api.removeTestProspect(id);
      void navigate("/outreach/prospects");
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }
  return (
    <Fold title="Test prospect">
      <div className="grid gap-3 px-2 py-1">
        <p className="text-body">This prospect is a test. Removing it takes away everything of it. No brand of your list can be removed.</p>
        <div>
          <Button type="button" variant="destructive" className={TAP} loading={busy} onClick={remove}>
            Remove the test prospect
          </Button>
        </div>
        <Failure error={error} />
      </div>
    </Fold>
  );
}
