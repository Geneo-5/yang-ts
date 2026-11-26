import YangConsole from "./yang-console";

export default function Home() {
  return <main className="page-shell">
    <header className="page-header">
      <p className="eyebrow">YANG Browser Engine · Stage 8.6</p>
      <h1>Static RESTCONF console</h1>
      <p>Discover a device model from its YANG Library, validate edits in the browser, then send them to RESTCONF.</p>
    </header>
    <YangConsole />
  </main>;
}
