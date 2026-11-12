/**
 * The import dialog: every selected scene and gallery with its record, an
 * editable "before -> after" per field, the related entity of the other kind
 * (and the link to it), and the studios, tags and performers Stash lacks.
 *
 * One host per app, mounted with the navbar: the menu patches stay pure
 * element edits, with no wrapper components that would hide the tree from
 * another plugin patching the same menu (inzVrGenerate does).
 */

import { Bootstrap, PluginApi, React, Router, useIntl } from "../../shared/stash";
import { errorText, toggled, uniq } from "../../shared/util";
import {
  createMiss,
  findByNames,
  loadDictionaries,
  loadEntities,
  loadSettings,
  lookup,
  refetchActive,
  updateEntity,
} from "./api";
import {
  buildJobs,
  buildPlans,
  collectMisses,
  emptyUiState,
  isOn,
  nodeStatus,
  recordId,
  recordPath,
  resolveNodes,
  rowKey,
  rowPatch,
  type Base,
  type Dictionaries,
  type Entity,
  type EntityPlan,
  type FieldRow,
  type Labels,
  type Miss,
  type NodeStatus,
  type PlanNode,
  type Related,
  type Settings,
  type Source,
  type UiState,
} from "./plan";
import * as R from "./records";
import { closeImport, dialog, type ImportRequest } from "./store";
import { TEXT, useStashText, useText, type TextId } from "./text";
import { Check, EntityHead } from "./ui";

const { Badge, Button, Form, Modal } = Bootstrap;
const { Link } = Router;

const FieldRows: React.FC<{
  entity: Entity;
  plan: EntityPlan | undefined;
  st: UiState;
  disabled: boolean;
  showAll: boolean;
  onShowAll: () => void;
  onCheck: (key: string, on: boolean) => void;
  onEdit: (key: string, value: string | null) => void;
}> = ({ entity, plan, st, disabled, showAll, onShowAll, onCheck, onEdit }) => {
  const text = useText();
  if (!plan) return null;

  const visible = plan.rows.filter((row) => row.proposed || showAll || st.edits.has(rowKey(entity, row)));
  const hidden = plan.rows.length - visible.length;

  const renderValue = (row: FieldRow, key: string, on: boolean) => {
    if (row.type === "list") {
      return (
        <span className="inz-records-added">
          {(row.added ?? []).map((item) => {
            const itemKey = `${key}|${item.id}`;
            const itemOn = isOn(st, itemKey, true);
            return (
              <Badge
                key={item.id}
                as="button"
                type="button"
                variant={itemOn ? "secondary" : "dark"}
                className={`mr-1 inz-records-chip${itemOn ? "" : " inz-records-chip-off"}`}
                disabled={disabled}
                onClick={() => onCheck(itemKey, !itemOn)}
              >
                {itemOn ? "+" : "−"} {item.name}
              </Badge>
            );
          })}
        </span>
      );
    }

    const before = <span className="inz-records-before text-muted">{row.before || text("inzRecords.empty")}</span>;
    const arrow = <span className="inz-records-arrow">→</span>;

    if (row.type === "studio" || row.type === "source") {
      return (
        <>
          {before}
          {arrow}
          <span className="inz-records-after">{row.after}</span>
          {row.before && on ? (
            <Badge variant="warning" className="inz-records-replaces">
              {text("inzRecords.replaces")}
            </Badge>
          ) : (
            <span />
          )}
        </>
      );
    }

    const value = st.edits.get(key) ?? row.after;
    const changed = rowPatch(entity, row, { ...st, checks: new Map([[key, true]]) }) !== null;
    const edited = st.edits.has(key);
    return (
      <>
        {before}
        {arrow}
        <span className="inz-records-after d-flex align-items-start">
          <Form.Control
            size="sm"
            as={row.type === "text" ? "input" : "textarea"}
            rows={row.type === "text" ? undefined : Math.min(6, Math.max(2, value.split("\n").length))}
            className={`inz-records-input${changed && on ? " inz-records-input-changed" : ""}`}
            value={value}
            placeholder={row.type === "urls" ? text("inzRecords.urls_hint") : undefined}
            disabled={disabled || !on}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const next = e.currentTarget.value;
              onEdit(key, next === row.after ? null : next);
            }}
          />
          {edited ? (
            <Button
              variant="link"
              size="sm"
              className="inz-records-reset"
              title={text("inzRecords.reset")}
              disabled={disabled}
              onClick={() => onEdit(key, null)}
            >
              ↺
            </Button>
          ) : null}
        </span>
        {row.before && changed && on ? (
          <Badge variant="warning" className="inz-records-replaces">
            {text("inzRecords.replaces")}
          </Badge>
        ) : (
          <span />
        )}
      </>
    );
  };

  return (
    <div className="inz-records-fields">
      {visible.map((row) => {
        const key = rowKey(entity, row);
        const on = isOn(st, key, row.defaultOn);
        return (
          <div
            key={row.field}
            className={`inz-records-field${row.type === "source" ? " text-muted" : ""}`}
            title={row.type === "source" ? text("inzRecords.source_hint") : undefined}
          >
            <span>
              {row.type === "list" ? null : (
                <Check id={key} checked={on} disabled={disabled} onChange={() => onCheck(key, !on)} />
              )}
            </span>
            <span className="inz-records-label">{row.label}</span>
            {renderValue(row, key, on)}
          </div>
        );
      })}
      {hidden > 0 || showAll ? (
        <Button variant="link" size="sm" className="inz-records-more" onClick={onShowAll}>
          {showAll ? `▴ ${text("inzRecords.fewer_fields")}` : `▾ ${text("inzRecords.all_fields")} (+${hidden})`}
        </Button>
      ) : null}
    </div>
  );
};

const RecordLink: React.FC<{ entry: Source; onLeave: () => void }> = ({ entry, onLeave }) => {
  const text = useText();
  const link = R.parseUrl(entry.url);
  return (
    <span className="inz-records-url text-muted">
      {link ? (
        <a href={entry.url} target="_blank" rel="noopener noreferrer">
          {`${link.host}${link.pathname}`}
        </a>
      ) : null}{" "}
      ·{" "}
      <Link to={recordPath(entry)} title={text("inzRecords.open_record_hint")} onClick={onLeave}>
        {text("inzRecords.open_record")}
      </Link>
    </span>
  );
};

type DialogFilter = NodeStatus | "all";

export const ImportDialog: React.FC<{ request: ImportRequest; onClose: () => void }> = ({ request, onClose }) => {
  const text = useText();
  const stash = useStashText();
  const Toast = PluginApi.hooks.useToast();
  const { LoadingIndicator } = PluginApi.components;

  const label = React.useCallback<Labels>(
    (field) => {
      switch (field) {
        case "title":
          return stash("title", "Title");
        case "code":
          return stash("scene_code", "Studio Code");
        case "date":
          return stash("date", "Date");
        case "details":
          return stash("details", "Details");
        case "urls":
          return stash("urls", "URLs");
        case "studio":
          return stash("studio", "Studio");
        case "performers":
          return stash("performers", "Performers");
        case "tags":
          return stash("tags", "Tags");
        default:
          return text("inzRecords.source");
      }
    },
    [stash, text]
  );

  const baseRef = React.useRef<Base | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<PlanNode[] | null>(null);
  const [dicts, setDicts] = React.useState<Dictionaries | null>(null);
  const [settings, setSettings] = React.useState<Settings>({ source: true });
  const [choices, setChoices] = React.useState<Map<string, string>>(new Map());
  const [st, setSt] = React.useState<UiState>(emptyUiState);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [filter, setFilter] = React.useState<DialogFilter>("all");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [creating, setCreating] = React.useState<Set<string>>(new Set());

  const requested = (request.scenes?.length ?? 0) + (request.galleries?.length ?? 0);

  // Stage one: entities, their records, the dictionaries
  React.useEffect(() => {
    let live = true;
    (async () => {
      const [scenes, galleries, loaded, conf] = await Promise.all([
        loadEntities("scene", uniq(request.scenes ?? [])),
        loadEntities("gallery", uniq(request.galleries ?? [])),
        loadDictionaries(),
        loadSettings(),
      ]);
      const targets = [...scenes, ...galleries];
      const hits = await lookup(targets.flatMap((e) => e.basenames));
      if (!live) return;
      baseRef.current = { targets, hits, related: new Map() };
      setSettings(conf);
      setDicts(loaded);
      if (targets.length === 1) setOpen(new Set([targets[0].key]));
    })().catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [request]);

  // Stage two, again whenever a conflict is decided
  React.useEffect(() => {
    const base = baseRef.current;
    if (!base || !dicts) return;
    let live = true;
    resolveNodes(base, choices, findByNames)
      .then((resolved) => live && setNodes(resolved))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [choices, dicts !== null]);

  const plans = React.useMemo(
    () => (nodes && dicts ? buildPlans(nodes, dicts, label, settings) : new Map<string, EntityPlan>()),
    [nodes, dicts, label, settings]
  );
  const jobs = React.useMemo(() => (nodes ? buildJobs(nodes, plans, st) : []), [nodes, plans, st]);
  const misses = React.useMemo(() => (nodes ? collectMisses(nodes, plans, st) : []), [nodes, plans, st]);

  // What the record (and the edits) offer, before any switch is turned off
  const offered = React.useMemo<UiState>(() => ({ excluded: new Set(), checks: new Map(), edits: st.edits }), [st.edits]);

  const status = (node: PlanNode) => nodeStatus(node, plans, offered);

  const counts: Record<NodeStatus, number> = { ready: 0, current: 0, none: 0, conflict: 0 };
  for (const node of nodes ?? []) counts[status(node)] += 1;

  const toggleExcluded = (key: string) => setSt((s) => ({ ...s, excluded: toggled(s.excluded, key) }));
  const setCheck = (key: string, on: boolean) =>
    setSt((s) => {
      const checks = new Map(s.checks);
      checks.set(key, on);
      return { ...s, checks };
    });
  const setEdit = (key: string, value: string | null) =>
    setSt((s) => {
      const edits = new Map(s.edits);
      if (value === null) edits.delete(key);
      else edits.set(key, value);
      return { ...s, edits };
    });
  const toggleOpen = (key: string) => setOpen((o) => toggled(o, key));

  async function create(list: Miss[]) {
    const ids = list.map((m) => `${m.kind}|${m.name}`);
    setCreating((c) => new Set([...Array.from(c), ...ids]));
    try {
      for (const miss of list) await createMiss(miss);
    } catch (e) {
      Toast.error(e);
    }
    try {
      setDicts(await loadDictionaries());
    } catch (e) {
      Toast.error(e);
    }
    setCreating((c) => new Set(Array.from(c).filter((id) => !ids.includes(id))));
  }

  async function onImport() {
    const failed = new Map<string, string>();
    let done = 0;
    let links = 0;
    for (let i = 0; i < jobs.length; i++) {
      setBusy(text("inzRecords.importing", { done: i + 1, total: jobs.length }));
      const job = jobs[i];
      try {
        await updateEntity(job.kind, job.input);
        done += 1;
        links += job.links;
      } catch (e) {
        failed.set(job.key, errorText(e));
      }
    }
    await refetchActive();
    setBusy(null);
    if (done) Toast.success(text("inzRecords.imported_toast", { count: done, links }));
    request.onDone?.();
    if (failed.size) setErrors(failed);
    else onClose();
  }

  const fieldRows = (entity: Entity, disabled: boolean) => (
    <FieldRows
      entity={entity}
      plan={plans.get(entity.key)}
      st={st}
      disabled={disabled}
      showAll={open.has(`${entity.key}|all`)}
      onShowAll={() => toggleOpen(`${entity.key}|all`)}
      onCheck={setCheck}
      onEdit={setEdit}
    />
  );

  function renderRelated(rel: Related, parentOff: boolean) {
    const hasFields = rel.owner && plans.has(rel.entity.key);
    if (!rel.link && !hasFields) return null;
    const off = parentOff || st.excluded.has(rel.key);
    const isOpen = open.has(rel.key);
    const linkLabel = rel.entity.kind === "gallery" ? text("inzRecords.link_gallery") : text("inzRecords.link_scene");
    const failed = errors.get(rel.entity.key);
    return (
      <div key={rel.key} className="inz-records-related">
        <div className="inz-records-row">
          <Check id={rel.key} checked={!off} disabled={parentOff || !!busy} onChange={() => toggleExcluded(rel.key)} />
          {rel.link ? <span>{linkLabel}</span> : null}
          <EntityHead entity={rel.entity} />
          {rel.link ? null : <span className="text-muted">· {text("inzRecords.linked")}</span>}
          {hasFields ? (
            <Button variant="link" size="sm" className="inz-records-caret" onClick={() => toggleOpen(rel.key)}>
              {isOpen ? "▾" : "▸"} {text("inzRecords.fields")}
            </Button>
          ) : rel.isTarget ? (
            <span className="text-muted">· {text("inzRecords.own_row")}</span>
          ) : null}
          {failed ? <span className="text-danger">✗ {failed}</span> : null}
        </div>
        {hasFields && isOpen ? fieldRows(rel.entity, off || !!busy) : null}
      </div>
    );
  }

  function renderNode(node: PlanNode) {
    const entity = node.entity;
    const st0 = status(node);
    const failed = errors.get(entity.key);

    if (st0 === "none") {
      return (
        <div key={entity.key} className="inz-records-row text-muted">
          <span className="inz-records-mark">✗</span>
          <EntityHead entity={entity} strong />
          <span>{text("inzRecords.no_record_for", { name: entity.basenames[0] ?? "—" })}</span>
        </div>
      );
    }

    if (st0 === "conflict") {
      return (
        <div key={entity.key} className="inz-records-row">
          <span className="inz-records-mark text-warning">⚠</span>
          <EntityHead entity={entity} strong />
          <span>{text("inzRecords.conflict", { count: node.candidates.length })}</span>
          <Form.Control
            as="select"
            size="sm"
            className="inz-records-choose"
            value={choices.get(entity.key) ?? ""}
            disabled={!!busy}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              const value = e.currentTarget.value;
              setChoices((c) => {
                const next = new Map(c);
                if (value) next.set(entity.key, value);
                else next.delete(entity.key);
                return next;
              });
            }}
          >
            <option value="">{text("inzRecords.choose")}</option>
            {node.candidates.map((c) => (
              <option key={recordId(c)} value={recordId(c)}>
                {`${c.site} · ${c.record?.title || c.key}`}
              </option>
            ))}
          </Form.Control>
        </div>
      );
    }

    // A decided conflict stays switchable
    const chooser =
      node.candidates.length > 1 ? (
        <Button
          variant="link"
          size="sm"
          onClick={() =>
            setChoices((c) => {
              const next = new Map(c);
              next.delete(entity.key);
              return next;
            })
          }
        >
          {text("inzRecords.conflict", { count: node.candidates.length })}
        </Button>
      ) : null;

    const off = st.excluded.has(entity.key);
    const isOpen = open.has(entity.key);
    const plan = plans.get(entity.key);
    const summary =
      st0 === "current"
        ? [text("inzRecords.up_to_date")]
        : (plan?.rows ?? [])
            .filter((r) => r.type !== "source" && rowPatch(entity, r, st))
            .map((r) => r.label);
    const link = node.related.find((r) => r.link && !st.excluded.has(r.key));
    if (link && st0 === "ready") {
      const id = link.entity.kind === "gallery" ? "inzRecords.link_gallery" : "inzRecords.link_scene";
      summary.push(text(id).toLowerCase());
    }

    return (
      <div key={entity.key} className={`inz-records-node${st0 === "current" ? " inz-records-current" : ""}`}>
        <div className="inz-records-row">
          <Check id={entity.key} checked={!off} disabled={!!busy} onChange={() => toggleExcluded(entity.key)} />
          <Button variant="link" size="sm" className="inz-records-caret" onClick={() => toggleOpen(entity.key)}>
            {isOpen ? "▾" : "▸"}
          </Button>
          <EntityHead entity={entity} strong />
          <RecordLink entry={node.entry!} onLeave={onClose} />
          {isOpen ? null : <span className="text-muted inz-records-summary">{summary.join(" · ")}</span>}
          {chooser}
          {failed ? <span className="text-danger">✗ {failed}</span> : null}
        </div>
        {isOpen ? (
          <>
            {fieldRows(entity, off || !!busy)}
            <div className="inz-records-fields">{node.related.map((rel) => renderRelated(rel, off))}</div>
          </>
        ) : null}
      </div>
    );
  }

  const creatable = misses.filter((m) => m.status === "missing");
  const loading = !error && !nodes;
  const shown = (nodes ?? []).filter((n) => filter === "all" || status(n) === filter);
  const openable = shown.filter((n) => n.entry).map((n) => n.entity.key);
  const allOpen = openable.length > 0 && openable.every((k) => open.has(k));

  const chips: [DialogFilter, number, string][] = [
    ["all", nodes?.length ?? 0, text("inzRecords.filter.all")],
    ["ready", counts.ready, text("inzRecords.ready")],
    ["current", counts.current, text("inzRecords.up_to_date")],
    ["none", counts.none, text("inzRecords.no_record")],
    ["conflict", counts.conflict, text("inzRecords.conflicts")],
  ];

  return (
    <Modal show size="xl" scrollable onHide={busy ? () => undefined : onClose} dialogClassName="inz-records-dialog">
      <Modal.Header closeButton={!busy}>
        <Modal.Title>
          {text("inzRecords.import")} — {text("inzRecords.selected", { count: requested })}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error ? <div className="text-danger">{error}</div> : null}
        {loading ? <LoadingIndicator /> : null}
        {nodes ? (
          <>
            <div className="inz-records-toolbar">
              {nodes.length > 1
                ? chips
                    .filter(([key, count]) => key === "all" || count > 0)
                    .map(([key, count, name]) => (
                      <Button
                        key={key}
                        size="sm"
                        variant={filter === key ? "primary" : "secondary"}
                        onClick={() => setFilter(key)}
                      >
                        {name} {count}
                      </Button>
                    ))
                : null}
              {!jobs.length && counts.ready === 0 ? <span>{text("inzRecords.nothing")}</span> : null}
              {openable.length > 1 ? (
                <Button
                  variant="link"
                  size="sm"
                  className="ml-auto"
                  onClick={() =>
                    setOpen((o) => {
                      const next = new Set(o);
                      for (const k of openable) {
                        if (allOpen) next.delete(k);
                        else next.add(k);
                      }
                      return next;
                    })
                  }
                >
                  {allOpen ? text("inzRecords.collapse_all") : text("inzRecords.expand_all")}
                </Button>
              ) : null}
            </div>
            {shown.map(renderNode)}
            {misses.length ? (
              <div className="inz-records-misses">
                <h6>{text("inzRecords.not_in_stash")}</h6>
                {misses.map((miss) => {
                  const id = `${miss.kind}|${miss.name}`;
                  return (
                    <div key={id} className="inz-records-row">
                      <span>
                        {text(`inzRecords.kind.${miss.kind}` as TextId)} “{miss.name}” ×{miss.count}
                      </span>
                      {miss.status === "missing" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={creating.has(id) || !!busy}
                          onClick={() => create([miss])}
                        >
                          {text("inzRecords.create")}
                        </Button>
                      ) : (
                        <span className="text-muted">
                          — {text("inzRecords.ambiguous")}: {miss.candidates.join(", ")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        {busy ? <span className="mr-auto">{busy}</span> : null}
        {creatable.length > 1 ? (
          <Button variant="secondary" disabled={!!busy || creating.size > 0} onClick={() => create(creatable)}>
            {text("inzRecords.create_all")}
          </Button>
        ) : null}
        <Button variant="secondary" disabled={!!busy} onClick={onClose}>
          {stash("actions.cancel", "Cancel")}
        </Button>
        <Button disabled={!!busy || !jobs.length} onClick={onImport}>
          {text("inzRecords.import_n", { count: jobs.length })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

// Menu patches are not components and cannot call hooks; the host keeps these
// current so list menus get the same wording.
export const menuText = {
  import: `${TEXT["inzRecords.import"]}…`,
  generate: "Generate…",
};

export const DialogHost: React.FC = () => {
  dialog.changed.use();
  const text = useText();
  const intl = useIntl();
  menuText.import = `${text("inzRecords.import")}…`;
  menuText.generate = `${intl.formatMessage({ id: "actions.generate" })}…`;
  if (!dialog.pending) return null;
  // A new object per open, so the dialog starts over
  return <ImportDialog request={dialog.pending} onClose={closeImport} />;
};
