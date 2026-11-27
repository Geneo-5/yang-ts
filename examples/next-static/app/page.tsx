import YangConsole from "./yang-console";

export default function Home() {
  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">YANG Browser Engine · Stage 8</p>
        <h1>RESTCONF Console</h1>
        <p>
          Discover a device model from its YANG Library, validate edits in the browser,
          then send them to RESTCONF. This demo loads all available YANG modules from
          the mock server and compiles them into a form you can interact with.
        </p>
      </header>
      <YangConsole />
    </main>
  );
}
