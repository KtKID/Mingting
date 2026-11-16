export function PageNav({ current }: { current: "tasks" | "records" }) {
  return (
    <nav className="page-nav" aria-label="工作空间页面">
      <a href="/" aria-current={current === "tasks" ? "page" : undefined}>
        任务台
      </a>
      <a
        href="/records"
        aria-current={current === "records" ? "page" : undefined}
      >
        项目记录
      </a>
    </nav>
  );
}
