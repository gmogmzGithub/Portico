# frontend/src/lib/components/chat/Messages/Markdown/MarkdownTokens.svelte

## Patch Summary (v0.6.43)
- Purpose: Provide raw text to Collapsible for copy-to-clipboard actions on details blocks.
- User-visible: Copy buttons on details blocks copy the full decoded content.
- System behavior: Passes decoded details text and HTML segment bodies to Collapsible via `copyText`.

## Technical Details (v0.6.43 patch)
- Details tokens:
  - Adds `copyText={decode(token.text)}` on the main Collapsible block.
- HTML details segments:
  - Adds `copyText={decode(segment.body)}` on nested Collapsible blocks.

## Diffs by Feature (v0.6.43 -> patched)

### Pass copyText to Collapsible in details tokens
```diff
@@
         <Collapsible
             title={token.summary}
             open={$settings?.expandDetails ?? false}
             attributes={token?.attributes}
+            copyText={decode(token.text)}
             className="w-full space-y-1"
             dir="auto"
         >
```

### Pass copyText to Collapsible in HTML details segments
```diff
@@
                     <Collapsible
                         title={segment.summary}
                         open={$settings?.expandDetails ?? false}
                         attributes={segment.attributes}
+                        copyText={decode(segment.body)}
                         className="w-full space-y-1"
                         dir="auto"
                     >
```

## Repatch Plan for v0.7.2
1. Reapply `copyText` on details Collapsible blocks and keep decoded text.
2. Reapply `copyText` for HTML details segments if that parsing still exists.
3. Verify any v0.7.2 refactors still pass the raw decoded body for copy actions.
