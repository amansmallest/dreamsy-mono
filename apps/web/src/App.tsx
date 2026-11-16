import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { Account } from './pages/Account';
import { Activity } from './pages/Activity';
import { Explore } from './pages/Explore';
import { Groups, JoinGroup } from './pages/Groups';
import { Home } from './pages/Home';
import { Insights } from './pages/Insights';
import { SignIn } from './pages/SignIn';
import { Workspace } from './pages/workspace/Workspace';

function Gate() {
  const { state } = useAuth();
  if (state.status === 'loading') return <div className="boot"><Spinner size={28} /></div>;
  if (state.status === 'signedOut') return <SignIn />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="explore" element={<Explore />} />
        <Route path="games/:id" element={<Workspace />} />
        <Route path="activity" element={<Activity />} />
        <Route path="groups" element={<Groups />} />
        <Route path="join/:code" element={<JoinGroup />} />
        <Route path="insights" element={<Insights />} />
        <Route path="account" element={<Account />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider><Gate /></AuthProvider>
    </BrowserRouter>
  );
}
