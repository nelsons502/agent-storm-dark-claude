import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {sanitizeGitHubHtml} from './github-markdown.js';

describe(sanitizeGitHubHtml.name, () => {
    it('removes executable and embedded content while keeping safe markdown', () => {
        const sanitized = sanitizeGitHubHtml(`
            <script>alert(1)</script>
            <p onclick="alert(1)">Safe <a href="javascript:alert(1)">bad link</a></p>
            <form><input name="secret"></form>
            <svg><script>alert(2)</script></svg>
            <iframe src="https://example.com"></iframe>
            <a href="https://github.com/example">good link</a>
            <input type="radio" checked>
        `);

        assert.deepEquals(
            sanitized.replaceAll(/\s+/g, ' ').trim(),
            '<p>Safe <a target="_blank" rel="noopener noreferrer">bad link</a></p> <a href="https://github.com/example" target="_blank" rel="noopener noreferrer">good link</a> <input type="checkbox" checked="" disabled="">',
        );
    });
});
