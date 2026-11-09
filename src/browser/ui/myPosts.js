// myPosts.js - "My posts" lists everything you posted, in every room, and the admin tools.
// Everything is set as plain text, so a title can never run code.
import { getEntriesByAuthor } from '../storage/db.js';
import { getMyKeys } from '../../shared/signing.js';
import { isAdminKey } from '../../shared/admin.js';
import { getRoomName } from '../../shared/rooms.js';
import { safeLink } from '../../shared/safe.js';
import { clearAllPosts, deleteOwnPost } from '../network/deletes.js';

const CONFIRM_MS = 3000;
const CLEAR_CLICKS = 3;
const CLEAR_RESET_MS = 4000;

function formatDate(time) {
    return new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function makeRow(entry) {
    const row = document.createElement('li');
    row.className = 'my-post';

    const text = document.createElement('div');
    text.className = 'my-post-text';
    const title = document.createElement('a');
    title.className = 'my-post-title';
    title.href = safeLink(entry.sourceURL);
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = entry.title || 'Untitled';
    const meta = document.createElement('span');
    meta.className = 'my-post-meta';
    meta.textContent = `${getRoomName(entry.room)} · ${formatDate(entry.timestamp)}`;
    text.append(title, meta);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'my-post-delete';
    button.textContent = 'Delete';
    button.addEventListener('click', async () => {
        if (button.dataset.confirm !== 'yes') {
            button.dataset.confirm = 'yes';
            button.textContent = 'Sure?';
            setTimeout(() => {
                if (button.isConnected && !button.disabled) {
                    delete button.dataset.confirm;
                    button.textContent = 'Delete';
                }
            }, CONFIRM_MS);
            return;
        }
        button.disabled = true;
        await deleteOwnPost(entry.entryId).catch(() => false);
        renderMyPosts();
    });

    row.append(text, button);
    return row;
}

export async function renderMyPosts() {
    const { publicKey } = await getMyKeys();
    const posts = await getEntriesByAuthor(publicKey).catch(() => []);
    const rows = document.createDocumentFragment();
    posts.forEach((entry) => rows.append(makeRow(entry)));

    document.getElementById('my-posts-list').replaceChildren(rows);
    document.getElementById('my-posts-empty').hidden = posts.length > 0;
    document.getElementById('my-posts-summary').textContent = posts.length
        ? `${posts.length} post${posts.length === 1 ? '' : 's'} in all rooms. Deleting one removes it for everyone.`
        : '';
    document.getElementById('my-posts-count').textContent = posts.length ? `(${posts.length})` : '';
}

function setOpen(open) {
    document.getElementById('my-posts-modal').hidden = !open;
    if (open) {
        document.getElementById('name-modal').hidden = true;
        renderMyPosts();
        document.getElementById('my-posts-close').focus();
    }
}

// Three clicks, so nobody clears everything by accident
function setupClearAll() {
    const button = document.getElementById('clear-all-btn');
    let clicks = 0;
    let resetTimer;
    const labels = ['Clear all posts', 'Click 2 more times', 'Click 1 more time: deletes everything'];

    const reset = () => {
        clicks = 0;
        button.textContent = labels[0];
        button.dataset.step = '0';
    };

    button.addEventListener('click', async () => {
        clearTimeout(resetTimer);
        clicks += 1;
        if (clicks < CLEAR_CLICKS) {
            button.textContent = labels[clicks];
            button.dataset.step = String(clicks);
            resetTimer = setTimeout(reset, CLEAR_RESET_MS);
            return;
        }
        button.disabled = true;
        button.textContent = 'Clearing...';
        const cleared = await clearAllPosts().catch(() => false);
        button.disabled = false;
        reset();
        button.textContent = cleared ? 'All posts cleared' : 'Could not clear posts';
        resetTimer = setTimeout(reset, CLEAR_RESET_MS);
    });
    reset();
}

export async function initMyPosts() {
    const { publicKey } = await getMyKeys();
    document.getElementById('my-key').textContent = `${publicKey.slice(0, 10)}…`;
    document.getElementById('my-key').title = publicKey;
    document.getElementById('copy-key').addEventListener('click', async () => {
        await navigator.clipboard.writeText(publicKey).catch(() => {});
        document.getElementById('copy-key').textContent = 'Copied';
        setTimeout(() => { document.getElementById('copy-key').textContent = 'Copy'; }, 2000);
    });

    document.getElementById('admin-tools').hidden = !isAdminKey(publicKey);
    setupClearAll();

    document.getElementById('my-posts-btn').addEventListener('click', () => setOpen(true));
    document.getElementById('my-posts-close').addEventListener('click', () => setOpen(false));
    document.getElementById('my-posts-modal').addEventListener('click', (event) => {
        if (event.target.id === 'my-posts-modal') setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setOpen(false);
    });
    window.addEventListener('posts-changed', () => renderMyPosts());
    renderMyPosts();
}
