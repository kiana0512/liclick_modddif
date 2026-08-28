import { Component, type ErrorInfo, type ReactNode } from 'react';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error?: Error;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Liclick 3D Texture] UI crashed:', error, info);
  }

  openProjects() {
    const base = `/${(import.meta.env.BASE_URL ?? '/').split('/').filter(Boolean).join('/')}`;
    window.location.assign(`${base === '/' ? '' : base}/projects`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-[#070713] p-6 text-white">
        <div className="grid w-full max-w-[520px] gap-4 rounded-lg border border-white/14 bg-white/[0.06] p-5 shadow-2xl">
          <div className="grid gap-1">
            <h1 className="text-lg font-semibold">编辑器界面发生错误</h1>
            <p className="text-sm leading-6 text-white/68">
              当前页面没有丢失项目数据。可以先返回项目列表，或者刷新页面重新进入编辑器。
            </p>
          </div>
          <pre className="max-h-40 overflow-auto rounded-md border border-white/10 bg-black/40 p-3 text-xs text-white/72">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              className="h-10 rounded-md bg-white px-4 text-sm font-semibold text-black"
              onClick={() => this.openProjects()}
            >
              返回项目列表
            </button>
            <button
              type="button"
              className="h-10 rounded-md border border-white/16 px-4 text-sm font-semibold text-white"
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
