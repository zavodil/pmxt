import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Prediction Copilot',
  description: 'Chat to find a prediction market to bet on.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
