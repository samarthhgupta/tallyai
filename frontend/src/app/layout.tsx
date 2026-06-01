import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { CompanyProvider } from '@/lib/companyContext';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'TallyAI',
  description: 'AI-powered invoice-to-Tally SaaS for Indian businesses',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-50 min-h-screen`}>
        <CompanyProvider>
          {children}
        </CompanyProvider>
      </body>
    </html>
  );
}
