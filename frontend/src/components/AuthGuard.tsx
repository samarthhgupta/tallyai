'use client';

// Auth guard is disabled — no login required in current build.
interface AuthGuardProps {
  children: (session: Record<string, never>) => React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  return <>{children({})}</>;
}
