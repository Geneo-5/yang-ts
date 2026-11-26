import { withYangEngine } from "../../dist/next/index.js";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH;

export default withYangEngine(
  { trailingSlash: true },
  { ...(basePath ? { basePath } : {}) },
);
