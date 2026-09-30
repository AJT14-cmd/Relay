import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  errorMessage,
  isAbort,
  parsePayload,
  readableStatus,
  request,
} from "./api";
import type {
  AcceptedEvent,
  CreatedEndpoint,
  Delivery,
  DeliveryDetail,
  DeliveryStatus,
  Endpoint,
  ReceiverMode,
  ReceiverState,
} from "./api";

type Page = "deliveries" | "endpoints" | "compose" | "receiver";
const pageInfo: Record<
  Page,
  { title: string; description: string; icon: string }
> = {
  deliveries: {
    title: "Deliveries",
    description: "Every event. Every attempt. A clear path to recovery.",
    icon: "activity",
  },
  endpoints: {
    title: "Endpoints",
    description: "Manage the destinations that receive your events.",
    icon: "target",
  },
  compose: {
    title: "Send an event",
    description: "Submit once. Relay takes care of the delivery.",
    icon: "send",
  },
  receiver: {
    title: "Receiver lab",
    description: "Make failures predictable. See reliability in action.",
    icon: "flask",
  },
};
const statuses: DeliveryStatus[] = [
  "PENDING",
  "IN_FLIGHT",
  "RETRY_WAIT",
  "SUCCEEDED",
  "EXHAUSTED",
  "CANCELLED",
];
const modeDescriptions: Record<ReceiverMode, string> = {
  success: "Acknowledge valid requests immediately.",
  fail: "Return HTTP 503 on every request until the mode changes.",
  flaky: "Return HTTP 503 for a set number of requests, then recover.",
  timeout:
    "Wait before processing and responding. If Relay times out first, no business effect is applied.",
  commit_then_timeout:
    "Apply the effect, then delay the response. Retried events are recognized as duplicates.",
};

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    activity: (
      <>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    send: (
      <>
        <path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3" />
      </>
    ),
    flask: (
      <>
        <path d="M9 3h6M10 3v7l-6 9a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2l-6-9V3M7 15h10" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>
    ),
    moon: <path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z" />,
    key: (
      <>
        <circle cx="8" cy="8" r="4" />
        <path d="m11 11 10 10m-3-3 3-3m-6 0 3-3" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    repeat: (
      <>
        <path d="M20 7H7a4 4 0 0 0-4 4m17-4-4-4m4 4-4 4M4 17h13a4 4 0 0 0 4-4M4 17l4 4m-4-4 4-4" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.activity}
    </svg>
  );
}

function date(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      <span />
      {readableStatus(status)}
    </span>
  );
}
function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}
function Empty({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
function readSessionKey() {
  try {
    return sessionStorage.getItem("relay-api-key") || "";
  } catch {
    return "";
  }
}
function usePolling(
  callback: (signal: AbortSignal) => Promise<void>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await callback(controller.signal);
      } catch (error) {
        if (!isAbort(error)) console.warn("Unable to refresh dashboard data.");
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [callback, enabled]);
}

export default function App() {
  const [apiKey, setApiKey] = useState(readSessionKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [page, setPage] = useState<Page>("deliveries");
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("relay-theme") === "dark";
    } catch {
      return false;
    }
  });
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(() => setRefreshVersion((v) => v + 1), []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("relay-theme", dark ? "dark" : "light");
    } catch {
      /* Storage is optional. */
    }
  }, [dark]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const [nextEndpoints, nextDeliveries] = await Promise.all([
          request<Endpoint[]>("/api/endpoints", apiKey, { signal }),
          request<Delivery[]>("/api/deliveries?limit=100", apiKey, { signal }),
        ]);
        if (signal.aborted) return;
        setEndpoints(nextEndpoints);
        setDeliveries(nextDeliveries);
        setError("");
        setLastUpdated(new Date().toISOString());
      } catch (err) {
        if (!signal.aborted) setError(errorMessage(err));
      }
    },
    [apiKey, refreshVersion],
  );
  usePolling(load, !!apiKey);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setConnectError("");
    const key = keyDraft.trim();
    try {
      const result = await request<Endpoint[]>("/api/endpoints", key);
      try {
        sessionStorage.setItem("relay-api-key", key);
      } catch {
        /* In-memory use still works. */
      }
      setEndpoints(result);
      setApiKey(key);
      setKeyDraft("");
    } catch (err) {
      setConnectError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  }
  function disconnect() {
    try {
      sessionStorage.removeItem("relay-api-key");
    } catch {
      /* Storage is optional. */
    }
    setApiKey("");
    setEndpoints([]);
    setDeliveries([]);
    setSelected(null);
    setError("");
    setLastUpdated(null);
  }
  function openDelivery(id: string) {
    setSelected(id);
    setPage("deliveries");
    refresh();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage("deliveries");
          }}
          aria-label="Relay home"
        >
          <span className="brand-mark">»</span>
          <span>
            relay<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-symbol">R</span>
          <div>
            Development<span>Webhook workspace</span>
          </div>
          <span className="small-dot" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {(Object.keys(pageInfo) as Page[]).map((item) => (
            <button
              key={item}
              className={`nav-link ${page === item ? "active" : ""}`}
              aria-current={page === item ? "page" : undefined}
              onClick={() => setPage(item)}
            >
              <Icon name={pageInfo[item].icon} />
              <span>{pageInfo[item].title}</span>
              {item === "deliveries" && deliveries.length > 0 && (
                <span className="nav-count">{deliveries.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="tiny-label">BUILT TO KEEP TRYING</span>
          <p>
            Durable events.
            <br />
            Visible delivery.
          </p>
          <div className="flow-art" aria-hidden="true">
            <span />
            <i />
            <span />
            <i />
            <span />
          </div>
        </div>
        <div className="sidebar-bottom">
          <span className="small-dot" />
          Local environment <span className="version">v1.0</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{pageInfo[page].title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={() => setDark((v) => !v)}
              aria-label={`Use ${dark ? "light" : "dark"} theme`}
            >
              <Icon name={dark ? "sun" : "moon"} />
            </button>
            <span className={`connection ${apiKey ? "online" : ""}`}>
              <span />
              {apiKey ? "Connected" : "Not connected"}
            </span>
            {apiKey && (
              <button className="button subtle small" onClick={disconnect}>
                Disconnect
              </button>
            )}
          </div>
        </header>
        <main id="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">WEBHOOK DELIVERY CONSOLE</p>
              <h1>{pageInfo[page].title}</h1>
              <p>{pageInfo[page].description}</p>
            </div>
            {apiKey && page === "deliveries" && (
              <button
                className="button primary"
                onClick={() => setPage("compose")}
              >
                <Icon name="send" size={17} />
                Send an event
              </button>
            )}
          </div>
          {!apiKey ? (
            <div className="welcome-grid">
              <section className="panel connect-panel">
                <span className="section-icon">
                  <Icon name="key" size={24} />
                </span>
                <h2>Connect to your workspace</h2>
                <p>
                  Enter the configured Relay API key to manage endpoints and
                  follow your events from acceptance to delivery.
                </p>
                <form onSubmit={connect}>
                  <label htmlFor="api-key">API key</label>
                  <input
                    id="api-key"
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    autoComplete="off"
                    required
                    placeholder="Your configured API key"
                  />
                  <p className="field-help">
                    Kept in this browser tab’s session storage. Cleared when you
                    disconnect.
                  </p>
                  {connectError && <Alert>{connectError}</Alert>}
                  <button
                    className="button primary"
                    disabled={connecting || !keyDraft.trim()}
                  >
                    {connecting ? "Connecting…" : "Connect workspace"}
                    <Icon name="arrow" size={17} />
                  </button>
                </form>
              </section>
              <section className="welcome-story">
                <span className="outline-tag">
                  A SMALL SERVICE. STRONG GUARANTEES.
                </span>
                <h2>
                  Give every event
                  <br />a way forward.
                </h2>
                <p>
                  Inspect attempts, watch retries recover, and replay exhausted
                  deliveries with the original event ID.
                </p>
                <ol className="steps">
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Register a destination</strong>
                      <p>Get a signing secret for your receiver.</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Send your first event</strong>
                      <p>The event and delivery job commit together.</p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Follow the delivery</strong>
                      <p>See status, history, and recovery in one place.</p>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          ) : (
            <>
              {error && (
                <Alert>
                  <strong>Refresh paused by an error.</strong> {error} The
                  console will retry automatically.
                </Alert>
              )}
              {page === "deliveries" && (
                <Deliveries
                  deliveries={deliveries}
                  endpoints={endpoints}
                  apiKey={apiKey}
                  selected={selected}
                  select={setSelected}
                  refresh={refresh}
                  lastUpdated={lastUpdated}
                  compose={() => setPage("compose")}
                />
              )}
              {page === "endpoints" && (
                <Endpoints
                  key={apiKey}
                  endpoints={endpoints}
                  apiKey={apiKey}
                  refresh={refresh}
                />
              )}
              {page === "compose" && (
                <EventComposer
                  key={apiKey}
                  endpoints={endpoints}
                  apiKey={apiKey}
                  onAccepted={openDelivery}
                  register={() => setPage("endpoints")}
                />
              )}
              {page === "receiver" && (
                <ReceiverLab key={apiKey} apiKey={apiKey} />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>Relay · Reliable webhook delivery</span>
            <span>
              At-least-once delivery · Bounded retries · No ordering guarantee
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Deliveries({
  deliveries,
  endpoints,
  apiKey,
  selected,
  select,
  refresh,
  lastUpdated,
  compose,
}: {
  deliveries: Delivery[];
  endpoints: Endpoint[];
  apiKey: string;
  selected: string | null;
  select: (id: string | null) => void;
  refresh: () => void;
  lastUpdated: string | null;
  compose: () => void;
}) {
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const succeeded = deliveries.filter((d) => d.status === "SUCCEEDED").length;
  const retrying = deliveries.filter((d) =>
    ["PENDING", "IN_FLIGHT", "RETRY_WAIT"].includes(d.status),
  ).length;
  const exhausted = deliveries.filter((d) => d.status === "EXHAUSTED").length;
  const rows = deliveries.filter(
    (d) =>
      (filter === "ALL" || d.status === filter) &&
      `${d.eventId} ${d.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="stats-grid">
        {[
          {
            label: "Recent deliveries",
            count: deliveries.length,
            note: "Latest 100 events",
            color: "",
          },
          {
            label: "Delivered",
            count: succeeded,
            note: "Acknowledged by receiver",
            color: "green",
          },
          {
            label: "In progress",
            count: retrying,
            note: "Queued, sending, or retrying",
            color: "amber",
          },
          {
            label: "Needs attention",
            count: exhausted,
            note: "Retry policy exhausted",
            color: "red",
          },
        ].map((stat) => (
          <div className={`stat-card ${stat.color}`} key={stat.label}>
            <div className="stat-label">
              {stat.label}
              <span className="stat-dot" />
            </div>
            <strong>{stat.count.toLocaleString()}</strong>
            <span>{stat.note}</span>
          </div>
        ))}
      </div>
      <div className={`delivery-layout ${selected ? "with-detail" : ""}`}>
        <section className="panel table-panel">
          <div className="panel-heading">
            <div>
              <h2>Delivery activity</h2>
              <p>Live status for your latest 100 deliveries</p>
            </div>
            <span className="live">
              <span />
              Live · 2.5s
            </span>
          </div>
          <div className="table-toolbar">
            <label className="sr-only" htmlFor="delivery-search">
              Search by event or delivery ID
            </label>
            <input
              id="delivery-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search event or delivery ID…"
            />
            <label className="sr-only" htmlFor="status-filter">
              Filter status
            </label>
            <select
              id="status-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="ALL">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {readableStatus(s)}
                </option>
              ))}
            </select>
          </div>
          {rows.length === 0 ? (
            <Empty
              icon="activity"
              title={
                deliveries.length
                  ? "No matching deliveries"
                  : "Your first event starts here"
              }
            >
              <p>
                {deliveries.length
                  ? "Try a different event ID or status filter."
                  : "Send an event and watch Relay deliver it to your endpoint."}
              </p>
              {!deliveries.length && (
                <button className="button secondary" onClick={compose}>
                  Send an event
                  <Icon name="arrow" size={16} />
                </button>
              )}
            </Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Last updated</th>
                    <th>
                      <span className="sr-only">View</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr
                      key={d.id}
                      className={selected === d.id ? "selected-row" : ""}
                    >
                      <td>
                        <button
                          className="event-link"
                          onClick={() => select(d.id)}
                          title={d.eventId}
                        >
                          {d.eventId}
                        </button>
                        <span className="cell-secondary">
                          {endpoints.find((e) => e.id === d.endpointId)?.url ||
                            d.endpointId}
                        </span>
                      </td>
                      <td>
                        <Badge status={d.status} />
                      </td>
                      <td className="mono">
                        {d.attemptCount}
                        <span className="cell-secondary">
                          {d.replayCount
                            ? `${d.replayCount} replay${d.replayCount === 1 ? "" : "s"}`
                            : "Original delivery"}
                        </span>
                      </td>
                      <td className="date-cell">{date(d.updatedAt)}</td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`Inspect ${d.eventId}`}
                          onClick={() => select(d.id)}
                        >
                          <Icon name="arrow" size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="table-footer">
            <span>
              {rows.length} of {deliveries.length} recent deliveries
            </span>
            <span>
              {lastUpdated
                ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : "Loading…"}
            </span>
          </div>
        </section>
        {selected && (
          <DeliveryInspector
            key={selected}
            id={selected}
            apiKey={apiKey}
            close={() => select(null)}
            refresh={refresh}
          />
        )}
      </div>
      <div className="info-strip">
        <Icon name="repeat" size={18} />
        <p>
          Receivers may see the same event more than once. Deduplicate business
          effects using the event ID.
        </p>
      </div>
    </>
  );
}

function DeliveryInspector({
  id,
  apiKey,
  close,
  refresh,
}: {
  id: string;
  apiKey: string;
  close: () => void;
  refresh: () => void;
}) {
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await request<DeliveryDetail>(
          `/api/deliveries/${encodeURIComponent(id)}`,
          apiKey,
          { signal },
        );
        if (!signal.aborted) {
          setDetail(data);
          setError("");
        }
      } catch (err) {
        if (!signal.aborted) setError(errorMessage(err));
      }
    },
    [id, apiKey],
  );
  usePolling(load, true);
  async function replay() {
    setBusy(true);
    setError("");
    try {
      setDetail(
        await request<DeliveryDetail>(
          `/api/deliveries/${encodeURIComponent(id)}/replay`,
          apiKey,
          { method: "POST" },
        ),
      );
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="panel inspector" aria-label="Delivery details">
      <div className="panel-heading">
        <h2>Delivery details</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close delivery details"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {!detail ? (
        <p className="loading">Loading attempt history…</p>
      ) : (
        <div className="inspector-body">
          <Badge status={detail.status} />
          <h3 className="break-all">{detail.eventId}</h3>
          <dl className="metadata">
            <dt>Delivery ID</dt>
            <dd className="mono break-all">{detail.id}</dd>
            <dt>Created</dt>
            <dd>{date(detail.createdAt)}</dd>
            <dt>Next attempt</dt>
            <dd>
              {["PENDING", "RETRY_WAIT"].includes(detail.status)
                ? date(detail.nextAttemptAt)
                : "—"}
            </dd>
            <dt>Attempts in this cycle</dt>
            <dd>{detail.cycleAttemptCount}</dd>
            <dt>Replays</dt>
            <dd>{detail.replayCount}</dd>
          </dl>
          {detail.lastError && (
            <div className="error-note">{detail.lastError}</div>
          )}
          {detail.status === "EXHAUSTED" && (
            <div className="replay-box">
              <p>
                Fix the receiver, then start a new retry cycle. The event ID and
                attempt history are preserved.
              </p>
              <button
                className="button primary"
                onClick={replay}
                disabled={busy}
              >
                <Icon name="repeat" size={16} />
                {busy ? "Replaying…" : "Replay delivery"}
              </button>
            </div>
          )}
          <div className="attempt-heading">
            <h3>Attempt history</h3>
            <span>{detail.attempts.length}</span>
          </div>
          {detail.attempts.length === 0 ? (
            <p className="muted">
              Waiting for a worker to claim this delivery.
            </p>
          ) : (
            <ol className="attempt-list">
              {[...detail.attempts]
                .sort((a, b) => b.attemptNumber - a.attemptNumber)
                .map((a) => (
                  <li key={a.id}>
                    <span
                      className={`attempt-dot ${a.httpStatus && a.httpStatus >= 200 && a.httpStatus < 300 ? "ok" : ""}`}
                    />
                    <div className="attempt-title">
                      <strong>Attempt {a.attemptNumber}</strong>
                      <span
                        className={
                          a.httpStatus &&
                          a.httpStatus >= 200 &&
                          a.httpStatus < 300
                            ? "text-success"
                            : ""
                        }
                      >
                        {a.httpStatus
                          ? `HTTP ${a.httpStatus}`
                          : a.finishedAt
                            ? "No response"
                            : "In progress"}
                      </span>
                    </div>
                    <time>{date(a.startedAt)}</time>
                    {a.durationMs != null && (
                      <span className="duration">
                        {a.durationMs.toLocaleString()} ms
                      </span>
                    )}
                    {a.error && <p className="attempt-error">{a.error}</p>}
                  </li>
                ))}
            </ol>
          )}
        </div>
      )}
    </aside>
  );
}

function Endpoints({
  endpoints,
  apiKey,
  refresh,
}: {
  endpoints: Endpoint[];
  apiKey: string;
  refresh: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState("");
  const [created, setCreated] = useState<CreatedEndpoint | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  async function register(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setCreated(
        await request<CreatedEndpoint>("/api/endpoints", apiKey, {
          method: "POST",
          body: JSON.stringify({ url: url.trim() }),
        }),
      );
      setUrl("");
      setCopied(false);
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function disable(id: string) {
    setDisabling(id);
    setError("");
    try {
      await request(
        `/api/endpoints/${encodeURIComponent(id)}/disable`,
        apiKey,
        { method: "POST" },
      );
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDisabling("");
    }
  }
  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.signingSecret);
      setCopied(true);
    } catch {
      setError(
        "Clipboard is unavailable. Select and copy the signing secret below.",
      );
    }
  }
  return (
    <>
      <div className="content-grid">
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <h2>Register an endpoint</h2>
              <p>Choose where Relay should send signed requests.</p>
            </div>
            <Icon name="target" />
          </div>
          <form onSubmit={register}>
            <label htmlFor="endpoint-url">Destination URL</label>
            <input
              id="endpoint-url"
              type="url"
              placeholder="https://your-service.example/webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              disabled={!!created}
            />
            <p className="field-help">
              Use an absolute HTTP or HTTPS URL. Relay sends a signed JSON event
              to this address.
            </p>
            {error && <Alert>{error}</Alert>}
            <button className="button primary" disabled={busy || !!created}>
              {busy ? "Registering…" : "Register endpoint"}
              <Icon name="arrow" size={17} />
            </button>
          </form>
          {created && (
            <div className="secret-box" role="status">
              <div className="secret-heading">
                <Icon name="check" size={18} />
                <strong>Endpoint registered</strong>
              </div>
              <p>
                Save this signing secret now. It will not be shown again after
                you leave this page or dismiss it.
              </p>
              <label htmlFor="signing-secret">Signing secret</label>
              <textarea
                id="signing-secret"
                readOnly
                rows={2}
                className="mono"
                value={created.signingSecret}
              />
              <div className="button-row">
                <button className="button secondary small" onClick={copySecret}>
                  <Icon name={copied ? "check" : "copy"} size={15} />
                  {copied ? "Copied" : "Copy secret"}
                </button>
                <button
                  className="button subtle small"
                  onClick={() => setCreated(null)}
                >
                  I’ve saved it
                </button>
              </div>
            </div>
          )}
        </section>
        <aside className="panel guide-panel">
          <span className="tiny-label">LOCAL DEMO</span>
          <h2>A receiver you can break.</h2>
          <p>
            Register the Compose receiver, save its secret, then configure that
            same secret in Receiver lab.
          </p>
          <code>http://receiver:8081/webhook</code>
          <p className="field-help">
            For a backend running directly on your computer, use{" "}
            <code>http://localhost:8081/webhook</code>. Local destinations
            require the development allowlist configuration.
          </p>
          <div className="guide-rule" />
          <h3>What disabling does</h3>
          <p>
            Disabling prevents new events and future claims for this endpoint. A
            request already in flight may still finish. Existing history remains
            available.
          </p>
        </aside>
      </div>
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2>
              Registered endpoints{" "}
              <span className="count-pill">{endpoints.length}</span>
            </h2>
            <p>Signing secrets are omitted from this list.</p>
          </div>
        </div>
        {endpoints.length === 0 ? (
          <Empty icon="target" title="No destinations yet">
            <p>Register your receiver to start delivering events.</p>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <strong className="endpoint-url">{e.url}</strong>
                      <span className="cell-secondary mono">{e.id}</span>
                    </td>
                    <td>
                      <Badge status={e.enabled ? "ENABLED" : "DISABLED"} />
                    </td>
                    <td className="date-cell">{date(e.createdAt)}</td>
                    <td>
                      {e.enabled ? (
                        <button
                          className="button danger-outline small"
                          onClick={() => disable(e.id)}
                          disabled={!!disabling}
                        >
                          {disabling === e.id ? "Disabling…" : "Disable"}
                        </button>
                      ) : (
                        <span className="muted">Disabled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function EventComposer({
  endpoints,
  apiKey,
  onAccepted,
  register,
}: {
  endpoints: Endpoint[];
  apiKey: string;
  onAccepted: (id: string) => void;
  register: () => void;
}) {
  const [id, setId] = useState<string>(() => crypto.randomUUID());
  const [endpointId, setEndpointId] = useState("");
  const [type, setType] = useState("order.created");
  const [payload, setPayload] = useState(
    '{\n  "orderId": "order_1042",\n  "amount": 4900,\n  "currency": "USD"\n}',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState<AcceptedEvent | null>(null);
  const enabled = endpoints.filter((e) => e.enabled);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setAccepted(null);
    setBusy(true);
    try {
      const result = await request<AcceptedEvent>("/api/events", apiKey, {
        method: "POST",
        body: JSON.stringify({
          id: id.trim(),
          endpointId,
          type: type.trim(),
          payload: parsePayload(payload),
        }),
      });
      setAccepted(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="content-grid">
      <section className="panel form-panel">
        <div className="panel-heading">
          <div>
            <h2>Compose an event</h2>
            <p>Every submission has a stable, client-supplied ID.</p>
          </div>
          <span className="method-tag">POST /api/events</span>
        </div>
        {!enabled.length ? (
          <Empty icon="target" title="Add a destination first">
            <p>You need an enabled endpoint to send an event.</p>
            <button className="button secondary" onClick={register}>
              Register endpoint
              <Icon name="arrow" size={16} />
            </button>
          </Empty>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="event-endpoint">Endpoint</label>
            <select
              id="event-endpoint"
              value={endpointId}
              onChange={(e) => setEndpointId(e.target.value)}
              required
            >
              <option value="" disabled>
                Select an endpoint
              </option>
              {enabled.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.url} · {e.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <div className="label-row">
              <label htmlFor="event-id">Event ID</label>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setId(crypto.randomUUID());
                  setAccepted(null);
                }}
              >
                Generate new ID
              </button>
            </div>
            <input
              id="event-id"
              className="mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
              required
              maxLength={128}
              pattern="[A-Za-z0-9._:\-]{1,128}"
              title="Use 1–128 letters, numbers, periods, underscores, colons, or hyphens."
            />
            <p className="field-help">
              Keep this ID unchanged to safely retry an identical submission.
            </p>
            <label htmlFor="event-type">Event type</label>
            <input
              id="event-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              required
              maxLength={128}
              placeholder="order.created"
            />
            <div className="label-row">
              <label htmlFor="event-payload">Payload</label>
              <span className="tiny-label">JSON OBJECT</span>
            </div>
            <textarea
              id="event-payload"
              className="code-input"
              rows={9}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              required
              spellCheck={false}
            />
            {error && <Alert>{error}</Alert>}
            {accepted && (
              <div className="success-note" role="status">
                <Icon name="check" size={18} />
                <div>
                  <strong>Event accepted</strong>
                  <p>
                    The event and its delivery job are saved. Identical repeated
                    submissions reuse the existing delivery.
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onAccepted(accepted.deliveryId)}
                  >
                    Inspect delivery →
                  </button>
                </div>
              </div>
            )}
            <button className="button primary" disabled={busy}>
              <Icon name="send" size={17} />
              {busy ? "Submitting…" : "Submit event"}
            </button>
          </form>
        )}
      </section>
      <aside className="panel guide-panel">
        <span className="tiny-label">THE DELIVERY CONTRACT</span>
        <h2>Accepted is the beginning.</h2>
        <p>
          A successful submission means the event is saved durably. Delivery
          happens asynchronously.
        </p>
        <ol className="contract-list">
          <li>
            <strong>Identical ID + content</strong>
            <p>Returns the existing event without creating another delivery.</p>
          </li>
          <li>
            <strong>Same ID + different content</strong>
            <p>
              Returns a conflict so an existing event cannot be overwritten.
            </p>
          </li>
          <li>
            <strong>Receiver failure</strong>
            <p>
              Temporary failures retry with backoff and jitter. Exhausted jobs
              stay available for replay.
            </p>
          </li>
        </ol>
      </aside>
    </div>
  );
}

function ReceiverLab({ apiKey }: { apiKey: string }) {
  const [state, setState] = useState<ReceiverState | null>(null);
  const [mode, setMode] = useState<ReceiverMode>("success");
  const [failures, setFailures] = useState(2);
  const [delay, setDelay] = useState(5000);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const initialized = useRef(false);
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await request<ReceiverState>(
          "/receiver-api/state",
          apiKey,
          { signal },
        );
        if (signal.aborted) return;
        setState(result);
        setPollError("");
        if (!initialized.current) {
          setMode(result.mode);
          setFailures(result.failuresRemaining);
          setDelay(result.delayMs);
          initialized.current = true;
        }
      } catch (err) {
        if (!signal.aborted) setPollError(errorMessage(err));
      }
    },
    [apiKey],
  );
  usePolling(load, true);
  async function configure(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setState(
        await request<ReceiverState>("/receiver-api/config", apiKey, {
          method: "POST",
          body: JSON.stringify({
            mode,
            failuresRemaining: failures,
            delayMs: delay,
            ...(secret.trim() ? { signingSecret: secret.trim() } : {}),
          }),
        }),
      );
      setSecret("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setError("");
    try {
      setState(
        await request<ReceiverState>("/receiver-api/reset", apiKey, {
          method: "POST",
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {pollError && <Alert>Receiver unavailable: {pollError}</Alert>}
      <div className="content-grid">
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <h2>Failure simulator</h2>
              <p>Configure how the demo receiver responds.</p>
            </div>
            <Icon name="flask" />
          </div>
          <form onSubmit={configure}>
            <label htmlFor="receiver-mode">Behavior</label>
            <select
              id="receiver-mode"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as ReceiverMode);
                setSaved(false);
              }}
            >
              <option value="success">Success · HTTP 200</option>
              <option value="fail">Always fail · HTTP 503</option>
              <option value="flaky">Fail a few times, then recover</option>
              <option value="timeout">Delay processing and response</option>
              <option value="commit_then_timeout">
                Process event, then delay response
              </option>
            </select>
            <p className="field-help">{modeDescriptions[mode]}</p>
            <div className="two-fields">
              <div>
                <label htmlFor="receiver-failures">
                  Failures before recovery
                </label>
                <input
                  id="receiver-failures"
                  type="number"
                  min="0"
                  max="1000"
                  value={failures}
                  onChange={(e) => setFailures(Number(e.target.value))}
                  disabled={mode !== "flaky"}
                  required
                />
              </div>
              <div>
                <label htmlFor="receiver-delay">Response delay (ms)</label>
                <input
                  id="receiver-delay"
                  type="number"
                  min="0"
                  max="60000"
                  step="100"
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  disabled={!["timeout", "commit_then_timeout"].includes(mode)}
                  required
                />
              </div>
            </div>
            <label htmlFor="receiver-secret">Endpoint signing secret</label>
            <input
              id="receiver-secret"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setSaved(false);
              }}
              placeholder={
                state?.signingSecretConfigured
                  ? "Configured · leave blank to keep"
                  : "Paste the secret from endpoint registration"
              }
            />
            <p className="field-help">
              Use the secret from your demo endpoint. A blank field preserves
              the receiver’s existing secret.
            </p>
            {error && <Alert>{error}</Alert>}
            {saved && (
              <div className="success-note" role="status">
                <Icon name="check" size={18} />
                Receiver configuration saved.
              </div>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Apply configuration"}
              <Icon name="check" size={17} />
            </button>
          </form>
        </section>
        <aside className="panel guide-panel">
          <span className="tiny-label">TRY THIS EXPERIMENT</span>
          <h2>
            One effect.
            <br />
            More than one delivery.
          </h2>
          <ol className="contract-list">
            <li>
              <strong>Process, then delay</strong>
              <p>
                Select this behavior and set the delay higher than the worker’s
                HTTP timeout.
              </p>
            </li>
            <li>
              <strong>Send one event</strong>
              <p>
                The receiver applies its effect, but Relay sees a timeout and
                retries.
              </p>
            </li>
            <li>
              <strong>Observe deduplication</strong>
              <p>
                Receipts increase. The business-effect count stays at one for
                that event ID.
              </p>
            </li>
          </ol>
          <p className="field-help">
            Switch back to Success to let a retry complete, or replay after the
            policy is exhausted. Receipt history is bounded and the receiver’s
            demo state is in memory.
          </p>
        </aside>
      </div>
      <div className="stats-grid receiver-stats">
        {[
          { label: "Requests received", value: state?.receivedCount },
          { label: "Business effects", value: state?.effectCount },
          { label: "Duplicate events", value: state?.duplicateCount },
        ].map((s) => (
          <div className="stat-card" key={s.label}>
            <div className="stat-label">{s.label}</div>
            <strong>{s.value?.toLocaleString() ?? "—"}</strong>
            <span>
              {s.label === "Business effects"
                ? "Deduplicated by event ID"
                : "Since the last reset"}
            </span>
          </div>
        ))}
      </div>
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2>Receiver receipts</h2>
            <p>
              Active mode:{" "}
              <strong>{state ? readableStatus(state.mode) : "loading"}</strong>
              {state?.mode === "flaky" &&
                ` · ${state.failuresRemaining} failures remaining`}
            </p>
          </div>
          <button
            className="button secondary small"
            disabled={busy || !state}
            onClick={reset}
          >
            Reset demo state
          </button>
        </div>
        <p className="table-caption">
          Reset clears receipts, counters, and deduplication state. The
          configured behavior and secret stay in place.
        </p>
        {!state?.receipts.length ? (
          <Empty icon="flask" title="Waiting for your experiment">
            <p>Configure the receiver, then submit an event to its endpoint.</p>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Event ID</th>
                  <th>Type</th>
                  <th>Event identity</th>
                  <th>Signature</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {[...state.receipts].reverse().map((r, index) => (
                  <tr key={`${r.eventId}-${r.receivedAt}-${index}`}>
                    <td className="mono break-all">{r.eventId}</td>
                    <td>{r.type}</td>
                    <td>
                      <Badge
                        status={r.duplicate ? "DUPLICATE" : "FIRST_SEEN"}
                      />
                    </td>
                    <td>
                      <span
                        className={
                          r.signatureValid ? "text-success" : "text-danger"
                        }
                      >
                        {r.signatureValid ? "Verified" : "Rejected"}
                      </span>
                    </td>
                    <td className="date-cell">{date(r.receivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
