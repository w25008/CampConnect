import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, MessageCircle, Send, Trash2, UserPlus, UserCheck, Home, Users, Mail, LogOut, RefreshCw, Search, Sparkles } from 'lucide-react';
import { supabase } from './lib/supabase.js';

const MAX_POST = 500;
const MAX_COMMENT = 300;
const MAX_MESSAGE = 1000;
const stamp = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const display = profile => profile?.display_name || profile?.handle || 'Member';
function Avatar({ profile }) { return <span className="avatar" aria-hidden="true">{display(profile).slice(0, 1).toUpperCase()}</span>; }

function Auth({ notify }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setError('');
    const h = handle.trim().toLowerCase();
    if (signup && (!/^[a-z][a-z0-9_]{2,33}$/.test(h) || !name.trim())) {
      setError('Enter a display name and a username of 3 to 34 lowercase letters, numbers, or underscores. The username must start with a letter.'); return;
    }
    setBusy(true);
    try {

      const result = signup
        ? await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim(), handle: h } } })
        : await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      if (signup && !result.data.session) notify('Account created. Check your email to confirm it, then sign in. If your username was taken, we assigned a unique one.');
    } catch (err) { setError(err.message || 'Could not continue.'); }
    finally { setBusy(false); }
  }
  return <div className="auth-wrap"><div className="auth-card">
    <div className="brand"><span className="brand-mark"><Sparkles size={20}/></span> CampConnect</div>
    <p className="eyebrow">A small space to connect</p><h1>{signup ? 'Create your account' : 'Welcome back'}</h1>
    <p className="muted">{signup ? 'Share thoughts and start conversations.' : 'Sign in to see your community.'}</p>
    <form className="stack-form" onSubmit={submit}>
      {signup && <><label>Display name<input required maxLength={60} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label><label>Username<input required minLength={3} maxLength={34} autoComplete="username" value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} placeholder="your_username" /></label><p className="muted">Shown publicly as @username. Use lowercase letters, numbers, or underscores; start with a letter.</p></>}
      <label>Email<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>Password<input required type="password" minLength={6} autoComplete={signup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Please wait...' : signup ? 'Create account' : 'Sign in'}</button>
    </form>
    <button className="text-button" onClick={() => { setSignup(!signup); setError(''); }}>{signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
  </div></div>;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('feed');
  const [profiles, setProfiles] = useState([]);
  const [posts, setPosts] = useState([]);
  const [likes, setLikes] = useState([]);
  const [counts, setCounts] = useState([]);
  const [commentsByPost, setCommentsByPost] = useState({});
  const [loadingComments, setLoadingComments] = useState({});
  const [searchResults, setSearchResults] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [searching, setSearching] = useState(false);
  const [follows, setFollows] = useState([]);
  const [messages, setMessages] = useState([]);
  const [recipient, setRecipient] = useState('');
  const [query, setQuery] = useState('');
  const [postText, setPostText] = useState('');
  const [messageText, setMessageText] = useState('');
  const [commentText, setCommentText] = useState({});
  const [openComments, setOpenComments] = useState({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const userId = session?.user?.id;
  const messageRequest = useRef(0);
  const recipientRef = useRef('');
  useEffect(() => {
    if (!supabase) { setChecking(false); return; }
    let active = true;
    supabase.auth.getSession().then(({ data, error: err }) => {
      if (active) { if (err) setError(err.message); setSession(data.session); setChecking(false); }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) { setSession(next); setChecking(false); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  const loadCommunity = useCallback(async (spin = false) => {
    if (!userId) return;
    if (spin) setLoading(true);
    try {
      const [postResult, recentProfiles, followResult] = await Promise.all([
        supabase.from('posts').select('id,author_id,body,created_at').order('created_at', { ascending: false }).limit(100),
        supabase.from('profiles').select('id,handle,display_name,created_at').order('created_at', { ascending: false }).limit(50),
        supabase.from('follows').select('follower_id,following_id').eq('follower_id', userId),
      ]);
      const firstError = [postResult, recentProfiles, followResult].find(r => r.error);
      if (firstError) throw firstError.error;
      const postRows = postResult.data || [];
      const ids = postRows.map(p => p.id);
      const authorIds = [...new Set([...postRows.map(p => p.author_id), userId])];
      const [authorResult, countResult, likeResult] = await Promise.all([
        supabase.from('profiles').select('id,handle,display_name,created_at').in('id', authorIds),
        ids.length ? supabase.from('post_counts').select('post_id,like_count,comment_count').in('post_id', ids) : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from('likes').select('post_id,user_id').eq('user_id', userId).in('post_id', ids) : Promise.resolve({ data: [], error: null }),
      ]);
      const secondError = [authorResult, countResult, likeResult].find(r => r.error);
      if (secondError) throw secondError.error;
      const byId = new Map([...(recentProfiles.data || []), ...(authorResult.data || [])].map(p => [p.id, p]));
      setProfiles([...byId.values()]); setPosts(postRows);
      setCounts(countResult.data || []); setLikes(likeResult.data || []);
      setFollows(followResult.data || []); setError('');
    } catch (err) { setError(err.message || 'Could not load the community.'); }
    finally { if (spin) setLoading(false); }
  }, [userId]);
  const loadComments = useCallback(async postId => {
    setLoadingComments(prev => ({ ...prev, [postId]: true }));
    const { data, error: err } = await supabase.from('comments')
      .select('id,post_id,author_id,body,created_at')
      .eq('post_id', postId).order('created_at', { ascending: false }).limit(100);
    if (err) { setError(err.message); }
    else {
      const rows = (data || []).reverse();
      setCommentsByPost(prev => ({ ...prev, [postId]: rows }));
      const authorIds = [...new Set(rows.map(c => c.author_id))];
      if (authorIds.length) {
        const { data: authors, error: authorError } = await supabase.from('profiles')
          .select('id,handle,display_name,created_at').in('id', authorIds);
        if (authorError) setError(authorError.message);
        else setProfiles(prev => [...new Map([...prev, ...(authors || [])].map(p => [p.id, p])).values()]);
      }
    }
    setLoadingComments(prev => ({ ...prev, [postId]: false }));
  }, []);
  const loadMessages = useCallback(async () => {
    if (!userId || !recipient) { setMessages([]); return; }
    const requestId = ++messageRequest.current;
    const { data, error: err } = await supabase.from('direct_messages')
      .select('id,sender_id,recipient_id,body,created_at')
      .or(`and(sender_id.eq.${userId},recipient_id.eq.${recipient}),and(sender_id.eq.${recipient},recipient_id.eq.${userId})`)
      .order('created_at', { ascending: false }).limit(200);
    if (requestId !== messageRequest.current || recipient !== recipientRef.current) return;
    if (err) setError(err.message); else { setMessages((data || []).reverse()); setError(''); }
  }, [userId, recipient]);
  useEffect(() => { if (userId) loadCommunity(true); else { setProfiles([]); setPosts([]); setMessages([]); } }, [userId, loadCommunity]);
  useEffect(() => { recipientRef.current = recipient; messageRequest.current += 1; setMessages([]); }, [recipient, userId]);
  useEffect(() => { if (tab === 'messages') loadMessages(); }, [tab, loadMessages]);
  useEffect(() => {
    if (!userId || tab !== 'people' || !query.trim()) { setSearchResults([]); setSearching(false); return undefined; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const term = query.trim().replace(/[^a-zA-Z0-9_ ]/g, '');
      if (!term) { if (!cancelled) { setSearchResults([]); setSearching(false); } return; }
      const { data, error: searchError } = await supabase.from('profiles')
        .select('id,handle,display_name,created_at')
        .or(`handle.ilike.%${term}%,display_name.ilike.%${term}%`)
        .order('created_at', { ascending: false }).limit(50);
      if (!cancelled) {
        if (searchError) setError(searchError.message);
        else setSearchResults(data || []);
        setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [userId, tab, query]);
  useEffect(() => {
    if (!userId) return undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') { if (tab === 'messages') loadMessages(); } }, 15000);
    return () => clearInterval(timer);
  }, [userId, tab, loadMessages]);
  const profileMap = useMemo(() => new Map([...profiles, ...searchResults, ...(selectedProfile ? [selectedProfile] : [])].map(p => [p.id, p])), [profiles, searchResults, selectedProfile]);
  const mine = profileMap.get(userId);
  const followingIds = new Set(follows.map(f => f.following_id));
  const others = [...new Map([...profiles, ...searchResults, ...(selectedProfile ? [selectedProfile] : [])].filter(p => p.id !== userId).map(p => [p.id, p])).values()];
  const filtered = query.trim() ? searchResults.filter(p => p.id !== userId) : others;
  async function mutate(key, operation, after) {
    setBusy(key); setError('');
    try {
      const result = await operation();
      if (result.error) throw result.error;
      if (after) after();
      await loadCommunity();
    } catch (err) { setError(err.message || 'Action failed. Please try again.'); }
    finally { setBusy(''); }
  }
  function publish(e) {
    e.preventDefault(); const body = postText.trim();
    if (!body || body.length > MAX_POST) return;
    mutate('post', () => supabase.from('posts').insert({ author_id: userId, body }), () => setPostText(''));
  }
  function addComment(e, id) {
    e.preventDefault(); const body = (commentText[id] || '').trim();
    if (!body || body.length > MAX_COMMENT) return;
    setBusy('comment'); setError('');
    supabase.from('comments').insert({ post_id: id, author_id: userId, body }).then(async ({ error: err }) => {
      if (err) setError(err.message);
      else {
        setCommentText(prev => ({ ...prev, [id]: '' }));
        await Promise.all([loadComments(id), loadCommunity()]);
      }
      setBusy('');
    });
  }
  async function sendMessage(e) {
    e.preventDefault(); const body = messageText.trim();
    if (!recipient || !body || body.length > MAX_MESSAGE) return;
    setBusy('message'); setError('');
    try {
      const { error: err } = await supabase.from('direct_messages').insert({ sender_id: userId, recipient_id: recipient, body });
      if (err) throw err;
      setMessageText(''); await loadMessages();
    } catch (err) { setError(err.message || 'Message could not be sent.'); }
    finally { setBusy(''); }
  }
  if (!supabase) return <div className="auth-wrap"><div className="auth-card"><div className="brand">CampConnect</div><h1>Connect your database</h1><p className="muted">Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in your deployment environment, then redeploy.</p></div></div>;
  if (checking) return <div className="center-state">Loading CampConnect...</div>;
  if (!session) return <><Auth notify={setNotice}/>{notice && <div className="toast" role="status">{notice}</div>}</>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Sparkles size={20}/></span> CampConnect</div>
      <nav aria-label="Main navigation">{[['feed', Home, 'Home'], ['people', Users, 'People'], ['messages', Mail, 'Messages']].map(([id, Icon, label]) => <button key={id} className={`nav-link ${tab === id ? 'selected' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={20}/>{label}</button>)}</nav>
      <div className="sidebar-bottom"><div className="account"><Avatar profile={mine}/><div><strong>{display(mine)}</strong><small>@{mine?.handle || 'loading'}</small></div></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={async () => { const { error: err } = await supabase.auth.signOut(); if (err) setError(err.message); }}><LogOut size={18}/></button></div>
    </aside>
    <main className="main-panel">
      <header className="main-header"><div><p className="eyebrow">Your community</p><h1>{tab === 'feed' ? 'Home' : tab === 'people' ? 'People' : 'Messages'}</h1></div><button className="icon-button" title="Refresh" aria-label="Refresh" onClick={() => { loadCommunity(true); if (tab === 'messages') loadMessages(); }}><RefreshCw size={19}/></button></header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">x</button></div>}
      {tab === 'feed' && <>
        <form className="composer panel" onSubmit={publish}><div className="composer-head"><Avatar profile={mine}/><label htmlFor="post-body">Share a thought</label></div><textarea id="post-body" value={postText} maxLength={MAX_POST} onChange={e => setPostText(e.target.value)} placeholder="What's happening?" rows={3}/><div className="composer-footer"><small>{postText.length}/{MAX_POST}</small><button className="primary" disabled={busy !== '' || !postText.trim()}><Send size={16}/> Post</button></div></form>
        <div className="section-heading"><h2>Latest posts</h2>{loading && <span>Loading...</span>}</div>
        {!loading && posts.length === 0 && <div className="empty panel">No posts yet. Write the first one above.</div>}
        {posts.map(post => {
          const author = profileMap.get(post.author_id);
          const count = counts.find(c => c.post_id === post.id);
          const liked = likes.some(l => l.post_id === post.id);
          const postComments = commentsByPost[post.id] || [];
          return <article className="post panel" key={post.id}>
            <div className="post-top"><Avatar profile={author}/><div className="post-author"><strong>{display(author)}</strong><small>@{author?.handle || 'member'} - {stamp(post.created_at)}</small></div>{post.author_id === userId && <button className="icon-button danger" title="Delete post" aria-label="Delete post" disabled={busy !== ''} onClick={() => { if (window.confirm('Delete this post?')) mutate('delete', () => supabase.from('posts').delete().eq('id', post.id)); }}><Trash2 size={17}/></button>}</div>
            <p className="post-body">{post.body}</p>
            <div className="post-actions"><button className={liked ? 'active' : ''} disabled={busy !== ''} aria-label={liked ? 'Unlike post' : 'Like post'} onClick={() => mutate('like', () => liked ? supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', userId) : supabase.from('likes').insert({ post_id: post.id, user_id: userId }))}><Heart size={18} fill={liked ? 'currentColor' : 'none'}/>{count?.like_count ?? 0}</button><button aria-expanded={!!openComments[post.id]} onClick={() => { if (!openComments[post.id]) loadComments(post.id); setOpenComments(prev => ({ ...prev, [post.id]: !prev[post.id] })); }}><MessageCircle size={18}/>{count?.comment_count ?? 0}</button></div>
            {openComments[post.id] && <div className="comments"><h3>Comments</h3>{loadingComments[post.id] && <p className="muted">Loading comments?</p>}{!loadingComments[post.id] && postComments.length === 0 && <p className="muted">No comments yet.</p>}{postComments.map(c => <div className="comment" key={c.id}><Avatar profile={profileMap.get(c.author_id)}/><div><strong>{display(profileMap.get(c.author_id))}</strong><small> - {stamp(c.created_at)}</small><p>{c.body}</p></div></div>)}<form onSubmit={e => addComment(e, post.id)} className="comment-form"><input aria-label="Write a comment" maxLength={MAX_COMMENT} placeholder="Write a comment..." value={commentText[post.id] || ''} onChange={e => setCommentText(prev => ({ ...prev, [post.id]: e.target.value }))}/><button className="primary" disabled={busy !== '' || !commentText[post.id]?.trim()} aria-label="Send comment"><Send size={16}/></button></form></div>}
          </article>;
        })}
      </>}
      {tab === 'people' && <div className="people-section"><label className="search-box"><Search size={19}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search people by name or handle" aria-label="Search people"/></label><div className="section-heading"><h2>Members</h2><span>{searching ? 'Searching?' : filtered.length}</span></div>{filtered.length === 0 && <div className="empty panel">{query ? 'No members match your search.' : 'No other members yet.'}</div>}{filtered.map(p => <div className="member panel" key={p.id}><Avatar profile={p}/><div className="member-info"><strong>{display(p)}</strong><small>@{p.handle}</small></div><div className="member-actions"><button className="secondary" disabled={busy !== ''} onClick={() => mutate('follow', () => followingIds.has(p.id) ? supabase.from('follows').delete().eq('follower_id', userId).eq('following_id', p.id) : supabase.from('follows').insert({ follower_id: userId, following_id: p.id }))}>{followingIds.has(p.id) ? <UserCheck size={16}/> : <UserPlus size={16}/>} {followingIds.has(p.id) ? 'Following' : 'Follow'}</button><button className="secondary" onClick={() => { messageRequest.current += 1; setMessages([]); setSelectedProfile(p); setRecipient(p.id); setTab('messages'); }}><Mail size={16}/> Message</button></div></div>)}</div>}
      {tab === 'messages' && <div className="messages-layout"><div className="contact-list panel"><h2>New conversation</h2><p className="muted">Choose a member to send a private message.</p>{others.map(p => <button key={p.id} className={`contact ${recipient === p.id ? 'selected' : ''}`} onClick={() => { messageRequest.current += 1; setMessages([]); setRecipient(p.id); }}><Avatar profile={p}/><span><strong>{display(p)}</strong><small>@{p.handle}</small></span></button>)}{others.length === 0 && <p className="muted">No other members yet.</p>}</div><section className="conversation panel" aria-label="Conversation">{recipient ? <><div className="conversation-header"><Avatar profile={profileMap.get(recipient)}/><strong>{display(profileMap.get(recipient))}</strong><button className="icon-button" aria-label="Refresh messages" onClick={loadMessages}><RefreshCw size={17}/></button></div><div className="message-list" aria-live="polite">{messages.length === 0 && <div className="empty-message">No messages yet. Say hello.</div>}{messages.map(m => <div key={m.id} className={`message ${m.sender_id === userId ? 'mine' : ''}`}><p>{m.body}</p><small>{stamp(m.created_at)}</small></div>)}</div><form className="message-form" onSubmit={sendMessage}><input aria-label="Write a message" placeholder="Write a message..." maxLength={MAX_MESSAGE} value={messageText} onChange={e => setMessageText(e.target.value)}/><button className="primary" disabled={busy !== '' || !messageText.trim()} aria-label="Send message"><Send size={17}/></button></form></> : <div className="empty-message"><Mail size={28}/><p>Select someone to start a conversation.</p></div>}</section></div>}
    </main>
  </div>;
}





