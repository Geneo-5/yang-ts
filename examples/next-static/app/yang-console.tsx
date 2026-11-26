"use client";

import { useState } from "react";
import type * as YangEngine from "yang-browser-engine";

type Engine = typeof YangEngine;
type Model = ReturnType<Engine["createFormModel"]>;
type Client = ReturnType<Engine["createRestconfClient"]>;

const initialRestconfUrl = process.env.NEXT_PUBLIC_RESTCONF_URL ?? "http://127.0.0.1:8081/restconf";

export default function YangConsole() {
  const [restconfUrl, setRestconfUrl] = useState(initialRestconfUrl);
  const [status, setStatus] = useState("Not connected");
  const [model, setModel] = useState<Model>();
  const [engine, setEngine] = useState<Engine>();
  const [client, setClient] = useState<Client>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [etag, setEtag] = useState<string>();
  const [message, setMessage] = useState("");

  async function connect() {
    setStatus("Discovering YANG Library…");
    setMessage("");
    try {
      const api = await import("yang-browser-engine");
      const rootUrl = new URL(restconfUrl);
      const base = `${rootUrl.origin}${rootUrl.pathname.replace(/\/$/, "")}`;
      const libraryResponse = await fetch(`${base}/data/ietf-yang-library:yang-library`, {
        headers: { Accept: "application/yang-data+json" },
      });
      if (!libraryResponse.ok) throw new Error(`YANG Library returned HTTP ${libraryResponse.status}`);
      const inventory = api.yangLibraryInventory(await libraryResponse.json());
      const implementation = inventory.modules.find(row => row.conformance !== "import" && row.location);
      const moduleLocation = Array.isArray(implementation?.location) ? implementation.location[0] : implementation?.location;
      if (!moduleLocation) throw new Error("YANG Library has no implemented module with a source location");
      const sourceResponse = await fetch(moduleLocation, { headers: { Accept: "application/yang" } });
      if (!sourceResponse.ok) throw new Error(`YANG module request returned HTTP ${sourceResponse.status}`);
      const rootModule = api.parseYang(await sourceResponse.text());
      const loader = api.createRestconfModuleLoader({ baseUrl: base, libraryResource: "ietf-yang-library:yang-library" });
      const moduleSet = await api.resolveModuleSet([rootModule], loader);
      if (moduleSet.diagnostics.length) throw new Error(moduleSet.diagnostics.map(item => item.message).join("; "));
      const schema = api.compileYangModules(moduleSet);
      if (schema.diagnostics.length) throw new Error(schema.diagnostics.map(item => item.message).join("; "));
      const form = api.createFormModel(schema, { module: rootModule.argument });
      const restconf = api.createRestconfClient({ baseUrl: rootUrl.origin });
      const config = await restconf.send(api.createRestconfGetRequest([{ module: rootModule.argument, name: "oven" }], rootUrl.pathname));
      const configBody = await config.json();
      const current = api.readRestconfData(configBody, rootModule.argument, "oven");
      const initialValues = current && typeof current === "object" ? current as Record<string, unknown> : {};
      setValues(Object.fromEntries(form.fields.filter(field => field.path.startsWith("/oven/")).map(field => [field.path, initialValues[field.name] ?? field.defaultValue ?? ""])));
      setEtag(config.headers.get("etag") ?? undefined);
      setEngine(api);
      setModel(form);
      setClient(restconf);
      setStatus(`Connected · ${moduleSet.modules.length} module(s) · ${form.operations.length} operation(s)`);
    } catch (error) {
      setStatus("Connection failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function save() {
    if (!engine || !model || !client) return;
    const fields = model.fields.filter(field => field.path.startsWith("/oven/"));
    const failures = fields.flatMap(field => {
      const result = engine.validateFormValue(field, values[field.path]);
      return result.errors.map(problem => `${field.name}: ${problem.message}`);
    });
    if (failures.length) {
      setMessage(failures.join(" · "));
      return;
    }
    try {
      const request = engine.createRestconfUpdateRequest(
        [{ module: "oven", name: "oven" }],
        { module: "oven", name: "oven", data: Object.fromEntries(fields.map(field => [field.name, values[field.path]])) },
        new URL(restconfUrl).pathname,
      );
      const response = await client.send(request, etag ? { headers: { "If-Match": etag } } : {});
      setEtag(response.headers.get("etag") ?? etag);
      setMessage(`Configuration saved (HTTP ${response.status}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function invoke(operation: NonNullable<Model>["operations"][number]) {
    if (!engine || !client) return;
    try {
      const response = await client.send(engine.createRestconfRpcRequest(operation, operation.name === "insert-food" ? { time: "now" } : undefined));
      setMessage(`${operation.name} returned HTTP ${response.status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const dataFields = model?.fields.filter(field => field.path.startsWith("/oven/")) ?? [];
  return <section className="console-card" aria-label="YANG console">
    <label className="url-field">RESTCONF base URL<input value={restconfUrl} onChange={event => setRestconfUrl(event.target.value)} /></label>
    <button className="primary-button" onClick={() => void connect()} disabled={status.startsWith("Discovering")}>Connect and load schema</button>
    <p className="status" role="status">{status}</p>
    {dataFields.length > 0 && <section aria-labelledby="configuration-heading">
      <h2 id="configuration-heading">Configuration</h2>
      <div className="fields">{dataFields.map(field => <label className="field" key={field.path}>
        <span>{field.label}</span>
        {field.control === "boolean" ? <input type="checkbox" checked={Boolean(values[field.path])} onChange={event => setValues(previous => ({ ...previous, [field.path]: event.target.checked }))} />
          : <input type="number" min="0" max="250" value={String(values[field.path] ?? "")} onChange={event => setValues(previous => ({ ...previous, [field.path]: Number(event.target.value) }))} />}
        <small>{field.help}</small>
      </label>)}</div>
      <button onClick={() => void save()}>Validate and save with PATCH</button>
    </section>}
    {model?.operations.length ? <section aria-labelledby="operations-heading">
      <h2 id="operations-heading">RPC operations</h2>
      <div className="operation-list">{model.operations.filter(operation => operation.kind === "rpc").map(operation => <button key={operation.name} onClick={() => void invoke(operation)}>{operation.label}</button>)}</div>
    </section> : null}
    {message && <p className="message" role="alert">{message}</p>}
  </section>;
}
