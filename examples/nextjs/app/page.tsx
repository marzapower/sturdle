export default function Home() {
  return (
    <main>
      <h1>Sturdle — Next.js example</h1>
      <p>
        The worker started with this server (see <code>instrumentation.ts</code>). Enqueue a job:
      </p>
      <pre>
        {`curl -X POST http://localhost:3000/api/enqueue \\
  -H 'content-type: application/json' \\
  -d '{"to":"someone@example.com","subject":"Hello"}'`}
      </pre>
      <p>Then watch the server log: the job runs within a second.</p>
    </main>
  );
}
