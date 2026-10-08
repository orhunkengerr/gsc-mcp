import type { Metadata } from "next";
import Link from "next/link";
import styles from "../page.module.css";

export const metadata: Metadata = { title: "Privacy Policy – GSC MCP" };

export default function Privacy() {
  return (
    <main className={styles.main}>
      <h1>Privacy Policy</h1>
      <p>Last updated: October 9, 2026</p>

      <h2>What we access</h2>
      <p>
        When you connect GSC MCP, you grant access to your Google Search Console data
        (<code>webmasters</code> scope) and read-only access to your Google Analytics 4 data
        (<code>analytics.readonly</code> scope). We only call these APIs when you ask ChatGPT to use one of the
        tools.
      </p>

      <h2>What we store</h2>
      <p>
        Nothing. GSC MCP has no database. Your Google tokens are encrypted and handed back to ChatGPT as the
        connection credential; the server keeps no copy. Search Console and Analytics data is fetched on demand,
        passed to ChatGPT in the response, and not saved or shared with anyone else. Only technical error
        messages are kept in the hosting provider&apos;s short-lived logs.
      </p>

      <h2>Changes to your data</h2>
      <p>
        Only the sitemap and property management tools change anything in your Search Console account, and only
        when you ask for it. Google Analytics access is read-only.
      </p>

      <h2>Revoking access</h2>
      <p>
        You can disconnect at any time by removing the connector in ChatGPT, or by removing &quot;GSC MCP&quot; at{" "}
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
      </p>

      <h2>Google API Services User Data Policy</h2>
      <p>
        GSC MCP&apos;s use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:orhunkengerr@gmail.com">orhunkengerr@gmail.com</a>
      </p>

      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
