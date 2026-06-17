import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { CompanyProvider } from '@/lib/companyContext';
import { SidebarProvider } from '@/lib/sidebarContext';
import { ThemeProvider } from '@/lib/themeContext';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'TallyAI',
  description: 'AI-powered invoice-to-Tally SaaS for Indian businesses',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Flash-prevention: apply dark class synchronously before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('tallyai_theme');if(t==='dark')document.documentElement.classList.add('dark');})();`,
          }}
        />
      </head>
      <body className={`${inter.className} min-h-screen`}>
        <ThemeProvider>
          <SidebarProvider>
            <CompanyProvider>
              {children}
            </CompanyProvider>
          </SidebarProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
