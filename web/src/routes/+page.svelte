<script lang="ts">
  import { onMount } from "svelte";

  type QueueItem = {
    caseId: string;
    version: number;
    action: string;
    priority: number;
    status: string;
    medicationCode: string;
    payerPlan: string;
    sourceWorkflow: string;
    sourceTaskId: string | null;
    correlationId: string;
    updatedAt: string | null;
  };

  let items: QueueItem[] = [];
  let selected: QueueItem | null = null;
  let reviewContext: Record<string, unknown> | null = null;
  let etag = "";
  let token = "";
  let reviewer = "synthetic-reviewer";
  let finalAnswer = "";
  let filter = "";
  let busy = false;
  let message = "";
  let messageKind: "info" | "success" | "error" = "info";

  const authHeaders = () => token.trim() ? { authorization: `Bearer ${token.trim()}` } : {};

  function nestedText(value: unknown, path: string[]): string {
    let cursor: unknown = value;
    for (const part of path) {
      if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return "";
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return typeof cursor === "string" ? cursor : "";
  }

  function draftAnswer(context: Record<string, unknown> | null): string {
    return nestedText(context, ["paDraft", "answer"])
      || nestedText(context, ["draft", "answer"])
      || nestedText(context, ["suggestedAnswer"]);
  }

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    const body = await response.json().catch(() => ({}));
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  }

  async function loadQueue(): Promise<void> {
    busy = true;
    message = "Loading synthetic review queue…";
    messageKind = "info";
    try {
      const response = await fetch("/api/v1/work-queue", { headers: authHeaders() });
      const body = await readJson(response);
      if (!response.ok) throw new Error(String((body.errors as Array<{ code?: string }> | undefined)?.[0]?.code ?? "queue_load_failed"));
      items = Array.isArray(body.items) ? body.items as QueueItem[] : [];
      message = `${items.length} actionable synthetic case${items.length === 1 ? "" : "s"} loaded.`;
      messageKind = "success";
      if (selected && !items.some((item) => item.caseId === selected?.caseId)) {
        selected = null;
        reviewContext = null;
        etag = "";
        finalAnswer = "";
      }
    } catch (error) {
      message = `Queue unavailable: ${error instanceof Error ? error.message : "unknown_error"}`;
      messageKind = "error";
    } finally {
      busy = false;
    }
  }

  async function openCase(item: QueueItem): Promise<void> {
    busy = true;
    selected = item;
    reviewContext = null;
    etag = "";
    finalAnswer = "";
    message = `Loading case ${item.caseId}…`;
    messageKind = "info";
    try {
      const response = await fetch(`/api/v1/cases/${encodeURIComponent(item.caseId)}/review-context`, {
        headers: authHeaders()
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(String((body.errors as Array<{ code?: string }> | undefined)?.[0]?.code ?? "review_context_failed"));
      reviewContext = body;
      etag = response.headers.get("etag") ?? "";
      finalAnswer = draftAnswer(body);
      message = etag ? "Review context loaded with optimistic-concurrency guard." : "Review context loaded; ETag is missing.";
      messageKind = etag ? "success" : "error";
    } catch (error) {
      message = `Review context unavailable: ${error instanceof Error ? error.message : "unknown_error"}`;
      messageKind = "error";
    } finally {
      busy = false;
    }
  }

  async function approve(): Promise<void> {
    if (!selected || !reviewContext || !etag) {
      message = "Reload the review context before submitting a decision.";
      messageKind = "error";
      return;
    }
    if (!reviewer.trim() || !finalAnswer.trim()) {
      message = "Reviewer and final answer are required.";
      messageKind = "error";
      return;
    }

    busy = true;
    message = "Submitting version-guarded review decision…";
    messageKind = "info";
    try {
      const response = await fetch(`/api/v1/cases/${encodeURIComponent(selected.caseId)}/approve`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "if-match": etag
        },
        body: JSON.stringify({ reviewer: reviewer.trim(), finalAnswer: finalAnswer.trim() })
      });
      const body = await readJson(response);
      if (response.status === 412) {
        reviewContext = null;
        etag = "";
        message = "This case changed after it was loaded. Reload the case before deciding again.";
        messageKind = "error";
        return;
      }
      if (!response.ok) throw new Error(String((body.errors as Array<{ code?: string }> | undefined)?.[0]?.code ?? "review_submit_failed"));
      message = "Synthetic review decision committed and routing transition accepted.";
      messageKind = "success";
      selected = null;
      reviewContext = null;
      etag = "";
      finalAnswer = "";
      await loadQueue();
    } catch (error) {
      message = `Decision not committed: ${error instanceof Error ? error.message : "unknown_error"}`;
      messageKind = "error";
    } finally {
      busy = false;
    }
  }

  $: visibleItems = items.filter((item) => {
    const q = filter.trim().toLowerCase();
    return !q || [item.caseId, item.medicationCode, item.payerPlan, item.action, item.status]
      .some((value) => String(value).toLowerCase().includes(q));
  });

  onMount(() => { void loadQueue(); });
</script>

<svelte:head>
  <title>RxFlow synthetic review console</title>
  <meta name="description" content="Synthetic human-review console for the RxFlow engineering project" />
</svelte:head>

<main>
  <header class="hero">
    <div>
      <p class="eyebrow">RXFLOW · SYNTHETIC DATA ONLY</p>
      <h1>Human review console</h1>
      <p class="lede">A version-guarded review surface for synthetic prior-authorisation workflow cases.</p>
    </div>
    <div class="boundary" role="note">
      <strong>Engineering boundary</strong>
      <span>No real patient data. No Epic or Surescripts integration. Not a clinical deployment.</span>
    </div>
  </header>

  <section class="controls" aria-labelledby="access-heading">
    <div>
      <h2 id="access-heading">Session</h2>
      <p>Credentials stay in page memory and are not written to local storage.</p>
    </div>
    <label>
      Synthetic reviewer bearer token
      <input bind:value={token} type="password" autocomplete="off" placeholder="optional for unprotected local queue; required for review context" />
    </label>
    <label>
      Reviewer identifier
      <input bind:value={reviewer} autocomplete="off" />
    </label>
    <button class="secondary" on:click={loadQueue} disabled={busy}>Refresh queue</button>
  </section>

  <p class:error={messageKind === "error"} class:success={messageKind === "success"} class="status" aria-live="polite">{message}</p>

  <div class="workspace">
    <section class="queue" aria-labelledby="queue-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">01 · TRIAGE</p>
          <h2 id="queue-heading">Actionable queue</h2>
        </div>
        <label class="search">
          Filter queue
          <input bind:value={filter} type="search" placeholder="case, medication, plan…" />
        </label>
      </div>

      {#if visibleItems.length === 0}
        <p class="empty">No matching actionable cases.</p>
      {:else}
        <div class="table-wrap">
          <table>
            <caption class="sr-only">Synthetic cases waiting for workflow action</caption>
            <thead>
              <tr><th>Priority</th><th>Case</th><th>Medication</th><th>Plan</th><th>Action</th><th></th></tr>
            </thead>
            <tbody>
              {#each visibleItems as item}
                <tr class:selected={selected?.caseId === item.caseId}>
                  <td><span class="priority">{item.priority}</span></td>
                  <td><code>{item.caseId.slice(0, 8)}</code><small>v{item.version}</small></td>
                  <td>{item.medicationCode}</td>
                  <td>{item.payerPlan}</td>
                  <td><span class="pill">{item.action}</span></td>
                  <td><button on:click={() => openCase(item)} disabled={busy}>Review</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="review" aria-labelledby="review-heading">
      <div class="section-heading">
        <div>
          <p class="eyebrow">02 · DECIDE</p>
          <h2 id="review-heading">Review context</h2>
        </div>
        {#if etag}<code class="etag" title="Optimistic concurrency ETag">{etag}</code>{/if}
      </div>

      {#if !selected}
        <p class="empty">Select a queue item to load its bounded review context.</p>
      {:else if !reviewContext}
        <p class="empty">Review context is not loaded. Use Review or reload after a stale decision.</p>
      {:else}
        <dl class="facts">
          <div><dt>Case</dt><dd><code>{selected.caseId}</code></dd></div>
          <div><dt>Status</dt><dd>{selected.status}</dd></div>
          <div><dt>Medication</dt><dd>{selected.medicationCode}</dd></div>
          <div><dt>Payer plan</dt><dd>{selected.payerPlan}</dd></div>
          <div><dt>Source</dt><dd>{selected.sourceWorkflow}</dd></div>
        </dl>

        <label class="answer">
          Final reviewed answer
          <textarea bind:value={finalAnswer} rows="8" maxlength="4000" placeholder="Review the synthetic draft and edit if needed"></textarea>
          <span>{finalAnswer.length} / 4000 characters</span>
        </label>

        <button class="approve" on:click={approve} disabled={busy || !etag || !finalAnswer.trim()}>Approve and route</button>

        <details>
          <summary>Inspect raw bounded review context</summary>
          <pre>{JSON.stringify(reviewContext, null, 2)}</pre>
        </details>
      {/if}
    </section>
  </div>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #f6f7f9; color: #15171a; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  :global(button), :global(input), :global(textarea) { font: inherit; }
  main { max-width: 1440px; margin: 0 auto; padding: 32px; }
  .hero { display: flex; justify-content: space-between; gap: 32px; align-items: flex-end; padding: 24px 0 28px; border-bottom: 1px solid #d9dde3; }
  h1 { margin: 4px 0 8px; font-size: clamp(2rem, 5vw, 4.4rem); line-height: .95; letter-spacing: -.05em; }
  h2 { margin: 2px 0 0; font-size: 1.2rem; }
  .eyebrow { margin: 0; font-size: .72rem; letter-spacing: .16em; font-weight: 750; }
  .lede { margin: 0; max-width: 680px; color: #545b65; }
  .boundary { max-width: 410px; display: grid; gap: 5px; padding: 16px; border: 1px solid #b9c2cd; background: white; border-radius: 12px; font-size: .86rem; }
  .boundary span, .controls p { color: #616872; }
  .controls { display: grid; grid-template-columns: 1.1fr 1.4fr 1fr auto; align-items: end; gap: 16px; margin: 22px 0; padding: 18px; background: white; border: 1px solid #d9dde3; border-radius: 14px; }
  .controls p { margin: 5px 0 0; font-size: .82rem; }
  label { display: grid; gap: 6px; font-size: .78rem; font-weight: 700; }
  input, textarea { width: 100%; border: 1px solid #bec5ce; border-radius: 8px; padding: 10px 12px; background: white; color: inherit; }
  input:focus, textarea:focus, button:focus-visible { outline: 3px solid rgba(21, 23, 26, .2); outline-offset: 2px; }
  button { border: 1px solid #15171a; background: #15171a; color: white; border-radius: 8px; padding: 9px 13px; cursor: pointer; font-weight: 720; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.secondary { background: white; color: #15171a; }
  .status { min-height: 24px; margin: 0 0 16px; padding: 8px 0; font-size: .9rem; }
  .status.error { color: #9a251f; font-weight: 650; }
  .status.success { color: #17613a; font-weight: 650; }
  .workspace { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(380px, .65fr); gap: 18px; align-items: start; }
  .queue, .review { background: white; border: 1px solid #d9dde3; border-radius: 14px; padding: 18px; min-width: 0; }
  .review { position: sticky; top: 16px; }
  .section-heading { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 16px; }
  .search { width: min(300px, 45%); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .84rem; }
  th { text-align: left; color: #666e78; font-size: .7rem; letter-spacing: .07em; text-transform: uppercase; padding: 9px 8px; border-bottom: 1px solid #d9dde3; }
  td { padding: 12px 8px; border-bottom: 1px solid #edf0f3; vertical-align: middle; }
  tr.selected { background: #f0f2f5; }
  td small { display: block; color: #737b85; margin-top: 3px; }
  .priority { display: inline-grid; place-items: center; min-width: 32px; padding: 4px 6px; background: #eef0f3; border-radius: 6px; font-weight: 800; }
  .pill { display: inline-block; padding: 5px 7px; border: 1px solid #ccd2d9; border-radius: 999px; font-size: .68rem; font-weight: 750; }
  .etag { font-size: .7rem; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .facts { display: grid; gap: 0; margin: 0 0 18px; border-top: 1px solid #e4e7eb; }
  .facts div { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px solid #e4e7eb; }
  dt { color: #68707a; font-size: .75rem; }
  dd { margin: 0; font-size: .83rem; overflow-wrap: anywhere; }
  .answer { margin-top: 18px; }
  .answer span { justify-self: end; color: #727a84; font-weight: 500; }
  textarea { resize: vertical; line-height: 1.5; }
  .approve { width: 100%; margin: 14px 0; padding: 12px; }
  details { margin-top: 10px; font-size: .8rem; }
  summary { cursor: pointer; font-weight: 700; }
  pre { max-height: 320px; overflow: auto; padding: 12px; background: #f4f5f7; border-radius: 8px; font-size: .72rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { color: #69717b; padding: 30px 8px; text-align: center; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 980px) {
    main { padding: 20px; }
    .hero { align-items: start; flex-direction: column; }
    .controls { grid-template-columns: 1fr 1fr; }
    .workspace { grid-template-columns: 1fr; }
    .review { position: static; }
  }
  @media (max-width: 640px) {
    main { padding: 14px; }
    .controls { grid-template-columns: 1fr; }
    .section-heading { align-items: stretch; flex-direction: column; }
    .search { width: 100%; }
  }
</style>
