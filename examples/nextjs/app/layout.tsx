import type { ReactNode } from "react";

export const metadata = { title: "Sturdle — Next.js example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "3rem auto", maxWidth: 640 }}>
        {children}
      </body>
    </html>
  );
}
