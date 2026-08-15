/**
 * UI half of INZ VR Preview.
 *
 * The python half rebuilds VR artifacts from one eye, but Stash only offers a
 * plugin a list of fixed, argument-less task buttons. Everything that describes
 * one run — which artifacts to build, for which scenes, over which folders —
 * therefore has to be asked for here and handed over as args_map.
 *
 * Two ways in:
 *
 *   - a switch inside Stash's own Generate dialog, so a normal generation is
 *     followed by ours over exactly the same scenes and artifacts;
 *   - a "Generate VR…" button under the plugin's tasks in Settings > Tasks,
 *     which opens the full dialog and runs the plugin on its own.
 */

type PatchFn = (target: string, fn: (...args: any[]) => any) => void;

interface IToast {
  success: (message: string) => void;
  error: (error: unknown) => void;
}

interface IPluginApi {
  React: typeof React;
  libraries: {
    Bootstrap: {
      Button: React.FC<any>;
      Form: React.FC<any> & { Control: React.FC<any>; Group: React.FC<any> };
      Modal: React.FC<any> & {
        Header: React.FC<any>;
        Title: React.FC<any>;
        Body: React.FC<any>;
        Footer: React.FC<any>;
      };
    };
  };
  components: Record<string, React.FC<any>>;
  hooks: {
    useToast: () => IToast;
  };
  patch: {
    before: PatchFn;
    instead: PatchFn;
    after: PatchFn;
  };
}

(function () {
  const PluginApi = (window as any).PluginApi as IPluginApi;
  const React = PluginApi.React;
  const { Button, Form, Modal } = PluginApi.libraries.Bootstrap;

  const PLUGIN_ID = "inzVrPreview";
  const TASK_NAME = "Process VR scenes";
  const GRAPHQL_URL = "/graphql";

  // The heading PluginTasks gives our block is the plugin's display name. It is
  // asked for below so that renaming the plugin does not orphan the button;
  // until the answer arrives, the name from the manifest stands in.
  let pluginName = "INZ VR Preview";

  // Everything the python half understands. The artifact names are deliberately
  // the field names of Stash's own GenerateMetadataInput, so the options ticked
  // in the Generate dialog can be forwarded without translation.
  interface IVrArgs {
    mode?: string;
    covers?: boolean;
    previews?: boolean;
    imagePreviews?: boolean;
    sprites?: boolean;
    markers?: boolean;
    overwrite?: boolean;
    sceneIds?: string[];
    paths?: string[];
    limit?: number;
    verbose?: boolean;
  }

  const ARTIFACT_KEYS = [
    "covers",
    "previews",
    "imagePreviews",
    "sprites",
    "markers",
  ] as const;

  // Kept before anything can replace it: the observer below wraps window.fetch,
  // and the plugin's own calls must not be observed or wrapped twice.
  const rawFetch = window.fetch.bind(window);

  async function graphql(query: string, variables?: Record<string, unknown>) {
    const response = await rawFetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(payload.errors[0].message ?? "graphql error");
    }
    return payload.data;
  }

  const RUN_TASK = `
    mutation InzVrRunTask($args: Map) {
      runPluginTask(
        plugin_id: "${PLUGIN_ID}"
        task_name: "${TASK_NAME}"
        description: "INZ VR Preview"
        args_map: $args
      )
    }
  `;

  // Not StashService.mutateRunPluginTask: its document declares $args_map but it
  // passes the variable as `args`, so the third argument is dropped on the floor
  // and the task would run with its defaultArgs only.
  function runVrTask(args: IVrArgs) {
    return graphql(RUN_TASK, { args });
  }

  graphql("query InzVrPlugins { plugins { id name } }")
    .then((data) => {
      const found = (data?.plugins ?? []).find((p: any) => p.id === PLUGIN_ID);
      if (found?.name) pluginName = found.name;
    })
    .catch(() => {
      /* the manifest name stands in */
    });

  /* ------------------------------------------------------------------ *
   * Riding along with Stash's own Generate
   * ------------------------------------------------------------------ */

  // Whether the switch in the Generate dialog is on. Module scope rather than
  // component state because the dialog is unmounted the moment it is submitted,
  // and because the choice should survive being reopened.
  let rideAlong = false;

  const VrGenerateSwitch: React.FC = () => {
    const BooleanSetting = PluginApi.components.BooleanSetting;
    const [checked, setChecked] = React.useState(rideAlong);

    if (!BooleanSetting) return null;

    return (
      <BooleanSetting
        id="inz-vr-preview-ride-along"
        heading="Rebuild VR artifacts from one eye"
        subHeading="Queues INZ VR Preview straight after this generation, over the same scenes and the same artifacts."
        checked={checked}
        onChange={(v: boolean) => {
          rideAlong = v;
          setChecked(v);
        }}
      />
    );
  };

  // GenerateOptions is not patchable, but every control it renders is, and the
  // overwrite switch is reliably its last one. Anchoring on the i18n key rather
  // than the element id keeps this from matching some other "overwrite".
  PluginApi.patch.after(
    "BooleanSetting",
    (props: any, _context: any, result: any) => {
      if (props?.headingID !== "dialogs.scene_gen.overwrite") return result;
      return React.createElement(
        React.Fragment,
        null,
        result,
        React.createElement(VrGenerateSwitch)
      );
    }
  );

  function vrArgsFromGenerate(input: any): IVrArgs | null {
    const args: IVrArgs = { mode: "process" };
    let anyArtifact = false;

    for (const key of ARTIFACT_KEYS) {
      if (input[key]) {
        args[key] = true;
        anyArtifact = true;
      }
    }
    // Stash was asked for nothing we can rebuild — phashes only, say — so there
    // is nothing to follow it with. Bailing out here also stops an empty set
    // from reaching the plugin, where "nothing named" means "everything".
    if (!anyArtifact) return null;

    if (input.overwrite) args.overwrite = true;
    if (input.sceneIDs?.length) args.sceneIds = input.sceneIDs.map(String);
    if (input.paths?.length) args.paths = input.paths.map(String);
    return args;
  }

  function readGenerateInput(body: unknown): any | null {
    if (typeof body !== "string") return null;
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return null;
    }
    if (payload?.operationName !== "MetadataGenerate") return null;
    return payload?.variables?.input ?? null;
  }

  // Stash has no post-generation hook, and neither GenerateDialog nor
  // mutateMetadataGenerate is patchable, so the only way to notice the dialog
  // being submitted is to watch the request go past. This observes and never
  // alters: the original response is returned untouched, and if Apollo ever
  // stops going through the global fetch the switch simply stops doing
  // anything, leaving the standalone dialog below unaffected.
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const response = rawFetch(...args);

    try {
      if (rideAlong) {
        const input = readGenerateInput((args[1] as RequestInit | undefined)?.body);
        const vrArgs = input ? vrArgsFromGenerate(input) : null;
        if (vrArgs) {
          // Only once the generation is actually queued: the task queue runs one
          // job at a time, so ours lands directly behind it.
          response
            .then((result) => {
              if (result.ok) return runVrTask(vrArgs);
            })
            .catch(() => {
              /* the generate call reports its own failure */
            });
        }
      }
    } catch {
      /* never let the observer break a request */
    }

    return response;
  } as typeof fetch;

  /* ------------------------------------------------------------------ *
   * The standalone dialog
   * ------------------------------------------------------------------ */

  const MODES = [
    ["process", "Process — rebuild what is missing or has been overwritten"],
    ["dryrun", "Dry run — report what would change, write nothing"],
    ["detect", "Detect layouts only — cache each verdict, log the raw scores"],
  ];

  interface IDialogProps {
    onClose: () => void;
  }

  const VrGenerateDialog: React.FC<IDialogProps> = ({ onClose }) => {
    const { Setting, BooleanSetting, FolderSelect } = PluginApi.components;
    const Toast = PluginApi.hooks.useToast();

    const [artifacts, setArtifacts] = React.useState<Record<string, boolean>>({
      covers: true,
      previews: true,
      imagePreviews: true,
      sprites: true,
      markers: true,
    });
    const [overwrite, setOverwrite] = React.useState(false);
    const [verbose, setVerbose] = React.useState(false);
    const [mode, setMode] = React.useState("process");
    const [limit, setLimit] = React.useState("0");
    const [paths, setPaths] = React.useState<string[]>([]);
    const [directory, setDirectory] = React.useState("");
    const [running, setRunning] = React.useState(false);

    const nothingSelected = !ARTIFACT_KEYS.some((key) => artifacts[key]);

    function addPath() {
      const value = directory.trim();
      if (!value || paths.includes(value)) return;
      setPaths([...paths, value]);
      setDirectory("");
    }

    async function onRun() {
      setRunning(true);
      try {
        const args: IVrArgs = { mode, verbose };
        for (const key of ARTIFACT_KEYS) {
          if (artifacts[key]) args[key] = true;
        }
        if (overwrite) args.overwrite = true;
        if (paths.length) args.paths = paths;

        const parsed = Number.parseInt(limit, 10);
        if (Number.isFinite(parsed) && parsed > 0) args.limit = parsed;

        await runVrTask(args);
        Toast.success("Added job to queue");
        onClose();
      } catch (e) {
        Toast.error(e);
      } finally {
        setRunning(false);
      }
    }

    function artifactSwitch(key: string, heading: string, subHeading?: string) {
      return (
        <BooleanSetting
          id={`inz-vr-${key}`}
          heading={heading}
          subHeading={subHeading}
          checked={artifacts[key]}
          onChange={(v: boolean) => setArtifacts({ ...artifacts, [key]: v })}
        />
      );
    }

    return (
      <Modal show size="lg" onHide={onClose}>
        <Modal.Header closeButton>
          <Modal.Title>Generate VR previews</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            {artifactSwitch("covers", "Scene covers")}
            {artifactSwitch("previews", "Previews")}
            {artifactSwitch("imagePreviews", "Animated previews")}
            {artifactSwitch("sprites", "Scene scrubber sprites")}
            {artifactSwitch("markers", "Marker previews")}

            <BooleanSetting
              id="inz-vr-overwrite"
              heading="Overwrite existing files"
              subHeading="Rebuild every artifact, ignoring what was generated before."
              checked={overwrite}
              onChange={setOverwrite}
            />

            <Setting
              heading="Mode"
              subHeading="A dry run writes nothing; detection caches each scene's layout without encoding."
            >
              <Form.Control
                className="input-control"
                as="select"
                value={mode}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  setMode(e.currentTarget.value)
                }
              >
                {MODES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Form.Control>
            </Setting>

            <Setting
              heading="Folders"
              subHeading={
                paths.length
                  ? paths.join("  ·  ")
                  : "Leave empty to consider every VR-tagged scene."
              }
            >
              <Button variant="secondary" size="sm" onClick={() => setPaths([])} disabled={!paths.length}>
                Clear
              </Button>
            </Setting>

            <Form.Group>
              {FolderSelect ? (
                <FolderSelect
                  currentDirectory={directory}
                  onChangeDirectory={setDirectory}
                  hideError
                  appendButton={
                    <Button variant="secondary" onClick={addPath} disabled={!directory.trim()}>
                      Add
                    </Button>
                  }
                />
              ) : (
                <Form.Control
                  className="text-input"
                  placeholder="Folder to restrict the run to"
                  value={directory}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setDirectory(e.currentTarget.value)
                  }
                />
              )}
            </Form.Group>

            <Setting
              heading="Scene limit"
              subHeading="Stop after this many scenes. 0 processes all of them."
            >
              <Form.Control
                className="text-input"
                type="number"
                min={0}
                value={limit}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setLimit(e.currentTarget.value)
                }
              />
            </Setting>

            <BooleanSetting
              id="inz-vr-verbose"
              heading="Verbose logging"
              subHeading="Log every command and decision, including the raw similarity scores."
              checked={verbose}
              onChange={setVerbose}
            />
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onRun} disabled={running || nothingSelected}>
            Generate
          </Button>
        </Modal.Footer>
      </Modal>
    );
  };

  const VrTaskLauncher: React.FC = () => {
    const Setting = PluginApi.components.Setting;
    const [showing, setShowing] = React.useState(false);

    if (!Setting) return null;

    return (
      <>
        <Setting
          heading="Generate VR…"
          subHeading="Choose what to rebuild and which folders to cover, then queue the run."
        >
          <Button variant="secondary" size="sm" onClick={() => setShowing(true)}>
            Generate VR…
          </Button>
        </Setting>
        {showing ? <VrGenerateDialog onClose={() => setShowing(false)} /> : null}
      </>
    );
  };

  // PluginTasks itself is not patchable, but it wraps each plugin's task list in
  // a SettingGroup headed by that plugin's name. Patching before rather than
  // after puts the button inside that group, under the plain tasks, instead of
  // loose beneath it. Before-hooks return the arguments to carry on with, and
  // React calls a component as fn(props, legacyContext).
  PluginApi.patch.before("SettingGroup", (props: any, context: any) => {
    if (props?.settingProps?.heading !== pluginName) return [props, context];

    const children = [
      props.children,
      React.createElement(VrTaskLauncher, { key: "inz-vr-launcher" }),
    ];
    return [{ ...props, children }, context];
  });
})();
