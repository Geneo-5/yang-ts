"use client";

import { useState } from "react";
import {
  parseYang,
  resolveModuleSet,
  compileYangModules,
  createFormModel,
  validateFormValue,
  createRestconfClient,
  createRestconfGetRequest,
  createRestconfUpdateRequest,
  createRestconfRpcRequest,
  readRestconfData,
  yangLibraryInventory,
  createRestconfModuleLoader,
} from "yang-browser-engine";

type Model = ReturnType<typeof createFormModel>;
type Client = ReturnType<typeof createRestconfClient>;

const initialRestconfUrl = process.env.NEXT_PUBLIC_RESTCONF_URL ?? "http://127.0.0.1:8081/restconf";

export default function YangConsole() {
  const [restconfUrl, setRestconfUrl] = useState(initialRestconfUrl);
  const [status, setStatus] = useState("Not connected");
  const [model, setModel] = useState<Model>();
  const [client, setClient] = useState<Client>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState("");

  async function connect() {
    setStatus("Discovering YANG Library…");
    setMessage("");
    try {
      const rootUrl = new URL(restconfUrl);
      const base = `${rootUrl.origin}${rootUrl.pathname.replace(/\/$/, "")}`;

      // Step 1: Fetch YANG Library inventory
      const libraryResponse = await fetch(`${base}/data/ietf-yang-library:yang-library`, {
        headers: { Accept: "application/yang-data+json" },
      });
      if (!libraryResponse.ok) throw new Error(`YANG Library returned HTTP ${libraryResponse.status}`);
      const inventory = yangLibraryInventory(await libraryResponse.json());

      // Step 2: Find implemented modules with source locations
      const implementations = inventory.modules.filter(row => row.conformance !== "import" && row.location);
      if (implementations.length === 0) throw new Error("No implemented modules found in YANG Library");

      // Step 3: Fetch all module sources and parse
      const modulePromises = implementations.map(async (impl) => {
        const moduleLocation = Array.isArray(impl.location) ? impl.location[0] : impl.location;
        if (!moduleLocation) return null;
        const response = await fetch(moduleLocation, { headers: { Accept: "application/yang" } });
        if (!response.ok) return null;
        return parseYang(await response.text());
      });

      const modules = (await Promise.all(modulePromises)).filter(Boolean) as any[];
      if (modules.length === 0) throw new Error("No YANG modules could be loaded");
      const rootModule = modules[0];

      // Step 4: Resolve module set and compile
      const loader = createRestconfModuleLoader({ baseUrl: base, libraryResource: "ietf-yang-library:yang-library" });
      const moduleSet = await resolveModuleSet(modules as any[], loader);
      if (moduleSet.diagnostics.length) console.warn("Module set diagnostics:", moduleSet.diagnostics);
      const schema = compileYangModules(moduleSet);
      if (schema.diagnostics.length) console.warn("Compile diagnostics:", schema.diagnostics);

      // Step 5: Create form model and RESTCONF client
      const form = createFormModel(schema, { module: rootModule.argument });
      const restconf = createRestconfClient({ baseUrl: rootUrl.origin });

      // Step 6: Load current configuration
      const config = await restconf.send(createRestconfGetRequest([{ module: rootModule.argument, name: "oven" }], rootUrl.pathname));
      const configBody = await config.json();
      const current = readRestconfData(configBody, rootModule.argument, "oven");
      const initialValues = current && typeof current === "object" ? (current as Record<string, unknown>) : {};

      setValues(Object.fromEntries(form.fields.filter(field => field.path.startsWith("/oven/")).map(field => [field.name, (initialValues as Record<string, unknown>)[field.name] ?? field.defaultValue ?? ""])));
      setModel(form);
      setClient(restconf);
      setStatus(`Connected · ${moduleSet.modules.length} module(s) · ${form.operations.length} operation(s)`);
    } catch (error) {
      setStatus("Connection failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function save() {
    if (!model || !client) return;
    const fields = model.fields.filter(field => field.path.startsWith("/oven/"));
    const failures = fields.flatMap(field => {
      const result = validateFormValue(field, values[field.name]);
      return result.errors.map(problem => `${field.name}: ${problem.message}`);
    });
    if (failures.length) {
      setMessage(failures.join(" · "));
      return;
    }
    try {
      const request = createRestconfUpdateRequest(
        [{ module: "oven", name: "oven" }],
        { module: "oven", name: "oven", data: Object.fromEntries(fields.map(field => [field.name, values[field.name]])) },
        new URL(restconfUrl).pathname,
      );
      const response = await client.send(request);
      setMessage(`Configuration saved (HTTP ${response.status}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function invoke(operation: any) {
    if (!client) return;
    try {
      const response = await client.send(createRestconfRpcRequest(operation, operation.name === "insert-food" ? { time: "now" } : undefined));
      setMessage(`${operation.name} returned HTTP ${response.status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const dataFields = model?.fields.filter(field => field.path.startsWith("/oven/")) ?? [];

  return (
    <section className="console-card" aria-label="YANG console">
      <label className="url-field">
        RESTCONF base URL
        <input value={restconfUrl} onChange={event => setRestconfUrl(event.target.value)} />
      </label>
      <button className="primary-button" onClick={() => void connect()} disabled={status.startsWith("Discovering")}>
        Connect and load schema
      </button>
      <p className="status" role="status">{status}</p>
      {dataFields.length > 0 && (
        <section aria-labelledby="configuration-heading">
          <h2 id="configuration-heading">Configuration</h2>
          <div className="fields">
            {dataFields.map(field => (
              <label className="field" key={field.path}>
                <span>{field.label}</span>
                {field.control === "boolean" ? (
                  <input type="checkbox" checked={Boolean(values[field.name])} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.checked }))} />
                ) : (
                  <input type="number" min="0" max="250" value={String(values[field.name] ?? "")} onChange={event => setValues(previous => ({ ...previous, [field.name]: Number(event.target.value) }))} />
                )}
                <small>{field.help}</small>
              </label>
            ))}
          </div>
          <button onClick={() => void save()}>Validate and save with PATCH</button>
        </section>
      )}
      {model?.operations.length ? (
        <section aria-labelledby="operations-heading">
          <h2 id="operations-heading">RPC operations</h2>
          <div className="operation-list">
            {model.operations.filter(operation => operation.kind === "rpc").map(operation => (
              <button key={operation.name} onClick={() => void invoke(operation)}>
                {operation.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {message && <p className="message" role="alert">{message}</p>}
    </section>
  );
}
