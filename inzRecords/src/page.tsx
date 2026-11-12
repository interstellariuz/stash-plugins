/**
 * /inz-records: every record received, its state in Stash, search and
 * filters, the full record on expand, import and delete by record, by
 * selection (Shift for a range) or by site. Also its two ways in: the navbar
 * icon and a link in the plugin's Settings block.
 */

import { Bootstrap, PluginApi, React, Router } from "../../shared/stash";
import { errorText, toggled } from "../../shared/util";
import { runOp } from "./api";
import { ROUTE } from "./ids";
import { recordId } from "./plan";
import * as R from "./records";
import { entitiesOf, type FileState, type RecordRow, type SiteRow } from "./status";
import {
  cachedReady,
  getRecord,
  openImport,
  refreshIfStale,
  refreshStatus,
  STALE_MS,
  status as statusStore,
} from "./store";
import { useStashText, useText, type TextId } from "./text";
import { Check, EntityLinks } from "./ui";

const { Badge, Button, Form, Modal, Table } = Bootstrap;
const { Link, NavLink, useLocation } = Router;

// Records page rows rendered at once
const PAGE_SIZE = 200;

function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

const fullTime = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
};

const STATE_VARIANT: Record<FileState, string> = { ready: "info", missing: "secondary", imported: "success" };
const STATE_TEXT: Record<FileState, TextId> = {
  ready: "inzRecords.page.ready",
  missing: "inzRecords.page.missing",
  imported: "inzRecords.page.imported",
};

const RecordDetail: React.FC<{
  row: RecordRow;
  onImport: () => void;
  onDelete: () => void;
}> = ({ row, onImport, onDelete }) => {
  const text = useText();
  const stash = useStashText();
  const { LoadingIndicator } = PluginApi.components;
  const [data, setData] = React.useState<any>(undefined);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    getRecord(row)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [row.id]);

  const record: R.CatalogRecord | undefined = data?.record;
  const byName = new Map(row.files.map((f) => [f.name.toLowerCase(), f]));
  const anyFound = row.files.some((f) => f.found.length);

  const field = (name: string, value: React.ReactNode) =>
    value ? (
      <>
        <dt>{name}</dt>
        <dd>{value}</dd>
      </>
    ) : null;

  return (
    <div className="inz-records-detail">
      {error ? <div className="text-danger">{error}</div> : null}
      {data === undefined && !error ? <LoadingIndicator inline small /> : null}
      {data === null ? <div className="text-muted">{text("inzRecords.page.gone")}</div> : null}
      {record ? (
        <>
          <dl className="inz-records-dl">
            {field(stash("title", "Title"), record.title)}
            {field(stash("date", "Date"), record.date)}
            {field(stash("studio", "Studio"), record.studio)}
            {field(
              stash("performers", "Performers"),
              (record.performers ?? []).length
                ? (record.performers ?? []).map((p) => (
                    <span key={p.name} className={`mr-2${p.ignored ? " text-muted inz-records-ignored" : ""}`}>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noopener noreferrer">
                          {p.name}
                        </a>
                      ) : (
                        p.name
                      )}
                    </span>
                  ))
                : null
            )}
            {field(
              stash("tags", "Tags"),
              (record.tags ?? []).length
                ? (record.tags ?? []).map((t) => (
                    <Badge key={t} variant="secondary" className="mr-1">
                      {t}
                    </Badge>
                  ))
                : null
            )}
            {field(
              stash("details", "Details"),
              record.description ? <div className="inz-records-description">{record.description}</div> : null
            )}
          </dl>
          <h6>{text("inzRecords.page.downloads")}</h6>
          <Table size="sm" className="inz-records-downloads">
            <tbody>
              {(record.downloads ?? []).map((d, i) => {
                const name = R.diskName(d);
                const file = byName.get(name.toLowerCase());
                return (
                  <tr key={`${d.slot}|${i}`}>
                    <td className="text-muted">{d.kind}</td>
                    <td className="text-break">{name || String(d.label ?? d.slot)}</td>
                    <td className="text-muted text-nowrap">
                      {d.savedAt
                        ? text("inzRecords.page.saved", { ago: ago(d.savedAt) })
                        : text("inzRecords.page.link_only")}
                    </td>
                    <td>
                      {!d.savedAt ? null : file?.found.length ? (
                        <EntityLinks found={file.found} />
                      ) : (
                        <span className="text-muted">{text("inzRecords.page.not_found")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      ) : null}
      <div className="inz-records-actions">
        <Button size="sm" disabled={!anyFound} onClick={onImport}>
          {text("inzRecords.page.import_one")}
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete}>
          {text("inzRecords.page.delete_one")}
        </Button>
      </div>
    </div>
  );
};

type SortBy = "updatedAt" | "title" | "site" | "state";

interface DeleteAsk {
  rows?: RecordRow[];
  site?: SiteRow;
}

const DeleteDialog: React.FC<{ ask: DeleteAsk; onClose: (deleted: boolean) => void }> = ({ ask, onClose }) => {
  const text = useText();
  const stash = useStashText();
  const Toast = PluginApi.hooks.useToast();
  const [busy, setBusy] = React.useState(false);

  async function run() {
    setBusy(true);
    try {
      const result = ask.site
        ? await runOp({ op: "delete", site: ask.site.site })
        : await runOp({ op: "delete", records: (ask.rows ?? []).map((r) => ({ site: r.site, key: r.key })) });
      Toast.success(text("inzRecords.page.deleted", { count: result?.deleted ?? 0 }));
      onClose(true);
    } catch (e) {
      Toast.error(e);
      setBusy(false);
    }
  }

  return (
    <Modal show onHide={() => !busy && onClose(false)}>
      <Modal.Header closeButton={!busy}>
        <Modal.Title>{text("inzRecords.page.delete_title")}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p>
          {ask.site
            ? text("inzRecords.page.delete_site_body", { count: ask.site.records, site: ask.site.site })
            : text("inzRecords.page.delete_body", { count: ask.rows?.length ?? 0 })}
        </p>
        {ask.rows && ask.rows.length <= 5 ? (
          <ul>
            {ask.rows.map((r) => (
              <li key={r.id} className="text-break">
                <span className="text-muted">{r.site}</span> {r.title || r.key}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted mb-0">{text("inzRecords.page.delete_note")}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" disabled={busy} onClick={() => onClose(false)}>
          {stash("actions.cancel", "Cancel")}
        </Button>
        <Button variant="danger" disabled={busy} onClick={run}>
          {stash("actions.delete", "Delete")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export const RecordsPage: React.FC = () => {
  statusStore.changed.use();
  const text = useText();
  const location = useLocation();
  const { LoadingIndicator } = PluginApi.components;

  const [error, setError] = React.useState<string | null>(null);
  const [site, setSite] = React.useState("");
  const [state, setState] = React.useState<FileState | "">("");
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<{ by: SortBy; desc: boolean }>({ by: "updatedAt", desc: true });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [limit, setLimit] = React.useState(PAGE_SIZE);
  const [focus, setFocus] = React.useState<string | null>(null);
  const [ask, setAsk] = React.useState<DeleteAsk | null>(null);
  const anchor = React.useRef<string | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLElement>());
  const scrolledTo = React.useRef<string | null>(null);

  /** Show one record: filters off, row open, scrolled to once */
  const focusOn = React.useCallback((id: string) => {
    setSite("");
    setState("");
    setSearch("");
    scrolledTo.current = null;
    setFocus(id);
    setExpanded((e) => new Set(e).add(id));
  }, []);

  const refresh = React.useCallback(() => {
    setError(null);
    refreshStatus().catch((e) => setError(errorText(e)));
  }, []);

  React.useEffect(refresh, []);

  // ?site=&key= (the dialog's "record" link): show that one, opened
  React.useEffect(() => {
    const params = new URLSearchParams(location.search);
    const s = params.get("site");
    const k = params.get("key");
    if (s && k) focusOn(recordId({ site: s, key: k }));
  }, [location.search]);

  const status = statusStore.last;
  const checking = statusStore.computing !== null;

  const visible = React.useMemo(() => {
    if (!status) return [];
    const needle = search.trim().toLowerCase();
    const list = status.records.filter(
      (r) =>
        (!site || r.site === site) && (!state || r.state === state) && (!needle || r.haystack.includes(needle))
    );
    const order = { ready: 0, missing: 1, imported: 2 };
    const cmp = (a: RecordRow, b: RecordRow) => {
      switch (sort.by) {
        case "title":
          return (a.title || a.key).localeCompare(b.title || b.key);
        case "site":
          return a.site.localeCompare(b.site) || b.updatedAt.localeCompare(a.updatedAt);
        case "state":
          return order[a.state] - order[b.state] || b.updatedAt.localeCompare(a.updatedAt);
        default:
          return a.updatedAt.localeCompare(b.updatedAt);
      }
    };
    list.sort((a, b) => (sort.desc ? -cmp(a, b) : cmp(a, b)));
    return list;
  }, [status, site, state, search, sort]);

  // The focused record: page far enough, then scroll to it once
  React.useEffect(() => {
    if (!focus || !status || scrolledTo.current === focus) return;
    const at = visible.findIndex((r) => r.id === focus);
    if (at >= limit) {
      setLimit(at + 1);
      return;
    }
    const el = rowRefs.current.get(focus);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    scrolledTo.current = focus;
  }, [focus, status, visible, limit]);

  // Selection only keeps records that still exist
  React.useEffect(() => {
    if (!status) return;
    const ids = new Set(status.records.map((r) => r.id));
    setSelected((s) => {
      const next = new Set(Array.from(s).filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [status]);

  React.useEffect(() => setLimit(PAGE_SIZE), [site, state, search, sort]);

  const shown = visible.slice(0, limit);
  const selectedRows = status ? status.records.filter((r) => selected.has(r.id)) : [];
  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  function onCheck(id: string, shift: boolean) {
    const on = !selected.has(id);
    const next = new Set(selected);
    const ids = visible.map((r) => r.id);
    const from = anchor.current ? ids.indexOf(anchor.current) : -1;
    const to = ids.indexOf(id);
    const range = shift && from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    for (const x of range) {
      if (on) next.add(x);
      else next.delete(x);
    }
    anchor.current = id;
    setSelected(next);
  }

  function selectAll() {
    setSelected((s) => {
      const next = new Set(s);
      for (const r of visible) {
        if (allSelected) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  }

  function selectSite(name: string) {
    if (!status) return;
    setSelected((s) => {
      const next = new Set(s);
      for (const r of status.records) if (r.site === name) next.add(r.id);
      return next;
    });
  }

  const importRows = (rows: RecordRow[], all: boolean) => openImport({ ...entitiesOf(rows, all), onDone: refresh });

  const onDeleted = (deleted: boolean) => {
    setAsk(null);
    if (deleted) {
      setSelected(new Set());
      refresh();
    }
  };

  const sortHead = (by: SortBy, name: string, className?: string) => (
    <th className={className}>
      <Button
        variant="link"
        size="sm"
        className="inz-records-sort"
        onClick={() => setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by === "updatedAt" }))}
      >
        {name}
        {sort.by === by ? (sort.desc ? " ▾" : " ▴") : ""}
      </Button>
    </th>
  );

  const lastRow = status?.last ? status.records.find((r) => r.id === recordId(status.last!)) : undefined;

  return (
    <div className="container-fluid inz-records-page">
      <div className="inz-records-head">
        <h2>{text("inzRecords.title")}</h2>
        <span className="text-muted">
          {checking
            ? text("inzRecords.page.checking")
            : status
            ? text("inzRecords.page.checked", { time: new Date(status.checkedAt).toLocaleTimeString() })
            : null}
        </span>
        <Button variant="secondary" size="sm" disabled={checking} onClick={refresh}>
          {text("inzRecords.page.refresh")}
        </Button>
      </div>
      {error ? <div className="text-danger mb-2">{error}</div> : null}
      {!status ? (
        checking ? (
          <LoadingIndicator />
        ) : null
      ) : (
        <>
          <p className="mb-1">
            {text("inzRecords.page.totals", { records: status.records.length, files: status.files, sites: status.sites })}
          </p>
          <p className="text-muted">
            {status.last ? (
              <>
                {text("inzRecords.page.last", { ago: ago(status.last.updatedAt), site: status.last.site })}{" "}
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 align-baseline"
                  onClick={() => lastRow && focusOn(lastRow.id)}
                >
                  {status.last.title || status.last.key}
                </Button>
              </>
            ) : (
              text("inzRecords.page.nothing_yet")
            )}
          </p>

          <div className="inz-records-states">
            {(["ready", "missing", "imported"] as FileState[]).map((s) => (
              <Button
                key={s}
                variant={state === s ? "primary" : "secondary"}
                className="inz-records-state"
                onClick={() => setState(state === s ? "" : s)}
              >
                <span className="inz-records-state-count">{status.counts[s]}</span>
                <span>{text(STATE_TEXT[s])}</span>
              </Button>
            ))}
            <Button
              className="inz-records-state"
              disabled={!status.counts.ready}
              onClick={() => importRows(status.records.filter((r) => r.state === "ready"), false)}
            >
              {text("inzRecords.page.import_all")}
            </Button>
          </div>

          {status.bySite.length ? (
            <details className="inz-records-sites" open={status.bySite.length <= 8}>
              <summary>
                {text("inzRecords.page.sites")} ({status.bySite.length})
              </summary>
              <Table striped size="sm">
                <thead>
                  <tr>
                    <th>{text("inzRecords.page.site")}</th>
                    <th className="text-right">{text("inzRecords.page.records")}</th>
                    <th className="text-right">{text("inzRecords.page.ready")}</th>
                    <th className="text-right">{text("inzRecords.page.missing")}</th>
                    <th className="text-right">{text("inzRecords.page.imported")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.bySite.map((s) => (
                    <tr key={s.site} className={site === s.site ? "table-active" : undefined}>
                      <td>
                        <Button
                          variant="link"
                          size="sm"
                          className="p-0"
                          onClick={() => setSite(site === s.site ? "" : s.site)}
                        >
                          {s.site}
                        </Button>
                      </td>
                      <td className="text-right">{s.records}</td>
                      <td className="text-right">{s.ready}</td>
                      <td className="text-right">{s.missing}</td>
                      <td className="text-right">{s.imported}</td>
                      <td className="text-right text-nowrap">
                        <Button variant="link" size="sm" className="py-0" onClick={() => selectSite(s.site)}>
                          {text("inzRecords.page.select_site")}
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          className="py-0 text-danger"
                          onClick={() => setAsk({ site: s })}
                        >
                          {text("inzRecords.page.delete_site")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </details>
          ) : null}

          <div className="inz-records-filters">
            <Form.Control
              size="sm"
              type="search"
              className="inz-records-search"
              placeholder={text("inzRecords.page.search")}
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.currentTarget.value)}
            />
            <Form.Control
              as="select"
              size="sm"
              className="inz-records-select"
              value={site}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSite(e.currentTarget.value)}
            >
              <option value="">{text("inzRecords.page.all_sites")}</option>
              {status.bySite.map((s) => (
                <option key={s.site} value={s.site}>
                  {s.site}
                </option>
              ))}
            </Form.Control>
            <Form.Control
              as="select"
              size="sm"
              className="inz-records-select"
              value={state}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setState(e.currentTarget.value as FileState | "")}
            >
              <option value="">{text("inzRecords.page.all_states")}</option>
              {(["ready", "missing", "imported"] as FileState[]).map((s) => (
                <option key={s} value={s}>
                  {text(STATE_TEXT[s])}
                </option>
              ))}
            </Form.Control>
            <span className="text-muted">
              {text("inzRecords.page.shown", { shown: shown.length, total: visible.length })}
            </span>
          </div>

          {selected.size ? (
            <div className="inz-records-bulk">
              <span>{text("inzRecords.selected", { count: selected.size })}</span>
              <Button
                size="sm"
                disabled={!selectedRows.some((r) => r.files.some((f) => f.found.length))}
                onClick={() => importRows(selectedRows, true)}
              >
                {text("inzRecords.page.import_selected", { count: selected.size })}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setAsk({ rows: selectedRows })}>
                {text("inzRecords.page.delete_selected", { count: selected.size })}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>
                {text("inzRecords.page.clear")}
              </Button>
            </div>
          ) : null}

          {visible.length ? (
            <Table size="sm" hover className="inz-records-table">
              <thead>
                <tr>
                  <th className="inz-records-check-cell">
                    <Check
                      id="all"
                      checked={allSelected}
                      title={text("inzRecords.page.select_all", { count: visible.length })}
                      onChange={selectAll}
                    />
                  </th>
                  {sortHead("title", text("inzRecords.page.record"))}
                  {sortHead("site", text("inzRecords.page.site"), "d-none d-md-table-cell")}
                  {sortHead("state", text("inzRecords.page.state"))}
                  <th className="d-none d-lg-table-cell">{text("inzRecords.page.in_stash")}</th>
                  {sortHead("updatedAt", text("inzRecords.page.received"), "text-nowrap")}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const isOpen = expanded.has(row.id);
                  const link = R.parseUrl(row.url);
                  const found = row.files.flatMap((f) => f.found);
                  return (
                    <React.Fragment key={row.id}>
                      <tr
                        ref={(el: HTMLTableRowElement | null) => {
                          if (el) rowRefs.current.set(row.id, el);
                          else rowRefs.current.delete(row.id);
                        }}
                        className={focus === row.id ? "inz-records-focus" : undefined}
                      >
                        <td className="inz-records-check-cell" title={text("inzRecords.page.shift_hint")}>
                          <Check id={row.id} checked={selected.has(row.id)} onChange={(shift) => onCheck(row.id, shift)} />
                        </td>
                        <td>
                          <Button
                            variant="link"
                            size="sm"
                            className="inz-records-title"
                            onClick={() => setExpanded((e) => toggled(e, row.id))}
                          >
                            {isOpen ? "▾ " : "▸ "}
                            {row.title || row.key}
                          </Button>
                          <div className="inz-records-sub text-muted">
                            <span className="d-md-none">{row.site} · </span>
                            {[row.date, row.studio].filter(Boolean).join(" · ")}
                            {row.date || row.studio ? " · " : ""}
                            {link ? (
                              <a href={row.url} target="_blank" rel="noopener noreferrer">
                                {`${link.host}${link.pathname}`}
                              </a>
                            ) : (
                              row.url
                            )}
                          </div>
                        </td>
                        <td className="d-none d-md-table-cell">{row.site}</td>
                        <td>
                          <Badge variant={STATE_VARIANT[row.state]}>{text(STATE_TEXT[row.state])}</Badge>
                        </td>
                        <td className="d-none d-lg-table-cell">
                          <EntityLinks found={found} />
                        </td>
                        <td className="text-nowrap text-muted" title={fullTime(row.updatedAt)}>
                          {ago(row.updatedAt)}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="inz-records-detail-row">
                          <td />
                          <td colSpan={5}>
                            <RecordDetail
                              row={row}
                              onImport={() => importRows([row], true)}
                              onDelete={() => setAsk({ rows: [row] })}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <p className="text-muted">{text("inzRecords.page.no_match")}</p>
          )}
          {visible.length > shown.length ? (
            <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              {text("inzRecords.page.more", { count: Math.min(PAGE_SIZE, visible.length - shown.length) })}
            </Button>
          ) : null}
        </>
      )}
      {ask ? <DeleteDialog ask={ask} onClose={onDeleted} /> : null}
    </div>
  );
};

/** Settings > Plugins: a way in from the plugin's own block */
export const SettingsLink: React.FC = () => {
  const text = useText();
  return (
    <div className="setting">
      <div>
        <h3>{text("inzRecords.title")}</h3>
      </div>
      <div>
        <Link className="btn btn-secondary btn-sm" to={ROUTE}>
          {text("inzRecords.settings.open")}
        </Link>
      </div>
    </div>
  );
};

/** Navbar icon, with the count of records ready to import */
export const NavButton: React.FC = () => {
  statusStore.changed.use();
  const text = useText();
  const { Icon } = PluginApi.components;
  const icon = PluginApi.libraries.FontAwesomeSolid.faFileImport;

  React.useEffect(() => {
    refreshIfStale();
    const timer = setInterval(refreshIfStale, STALE_MS);
    return () => clearInterval(timer);
  }, []);

  const ready = statusStore.last?.counts.ready ?? cachedReady();
  return (
    <NavLink className="nav-utility" exact to={ROUTE}>
      <Button className="minimal d-flex align-items-center h-100" title={text("inzRecords.title")}>
        <Icon icon={icon} />
        {ready ? (
          <Badge pill variant="info" className="ml-1">
            {ready}
          </Badge>
        ) : null}
      </Button>
    </NavLink>
  );
};
