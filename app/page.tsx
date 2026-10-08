import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1>GSC MCP</h1>
      <p>
        An MCP server that connects ChatGPT to your own Google Search Console and Google Analytics 4 data. You
        sign in with Google, and ChatGPT can then query your search performance, inspect URLs, manage sitemaps and
        read GA4 reports on your behalf.
      </p>
      <p>
        MCP server URL: <code>https://gsc-mcp-jet.vercel.app/api/mcp</code>
      </p>
      <p>
        Source code: <a href="https://github.com/orhunkengerr/gsc-mcp">github.com/orhunkengerr/gsc-mcp</a>
      </p>
      <p>
        <Link href="/privacy">Privacy Policy</Link>
      </p>
    </main>
  );
}
