import type { ReactNode } from 'react';

export const metadata = {
  title: 'forge',
  description: 'Operator UI for the forge autonomous multi-agent orchestrator.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
          background: '#0c1115',
          color: '#e6edf3',
        }}
      >
        {children}
      </body>
    </html>
  );
}
