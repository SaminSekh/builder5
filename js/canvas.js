// ============================================================
// canvas.js – Canvas rendering and drag-and-drop handling
// ============================================================

const Canvas = (() => {
    let dropIndex = null;
    let draggedBlockId = null;
    let draggedSubElement = null;
    let activeSubDrag = null;
    let activeSubDropTarget = null;
    const floatingBlockActions = {};

    function isVoidElement(el) {
        if (!el || !el.tagName) return true;
        return ['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'].includes(el.tagName.toUpperCase());
    }

    function canHostSubElements(el) {
        if (!el || isVoidElement(el)) return false;
        return true;
    }

    function canHostBlocks(el) {
        if (!el || !el.tagName) return false;
        return ['DIV', 'SECTION', 'NAV', 'HEADER', 'FOOTER', 'MAIN', 'ARTICLE', 'ASIDE', 'FORM', 'UL', 'OL', 'LI', 'FIGURE'].includes(el.tagName.toUpperCase());
    }

    function getBlockChildHost(content) {
        if (!content) return null;
        const explicit = content.querySelector('.container-inner');
        if (explicit) return explicit;
        const root = content.firstElementChild;
        if (canHostBlocks(root)) return root;
        return null;
    }

    function resolveDraggedBlockData(rawPayload) {
        if (!rawPayload) return null;
        const resolved = typeof Palette !== 'undefined' && Palette.resolvePayload
            ? Palette.resolvePayload(rawPayload)
            : (BlockTypes[rawPayload] ? { type: rawPayload, variantId: null } : null);
        if (!resolved || !resolved.type || !BlockTypes[resolved.type]) return null;

        if (typeof Palette !== 'undefined' && Palette.buildBlockFromVariant) {
            return Palette.buildBlockFromVariant(resolved.type, resolved.variantId);
        }

        return {
            type: resolved.type,
            props: JSON.parse(JSON.stringify(BlockTypes[resolved.type].defaultProps))
        };
    }

    function init() {
        const canvas = document.getElementById('canvas');
        const canvasFrame = document.getElementById('canvasFrame');
        const canvasWrapper = document.getElementById('canvasWrapper');

        const handleRootDragOver = (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = draggedBlockId ? 'move' : 'copy';
            canvas.classList.add('drag-over');
            const afterEl = getDragAfterElement(canvas, e.clientX, e.clientY);
            dropIndex = afterEl ? getBlockIndexFromEl(afterEl) : null;
        };

        const handleRootDragLeave = (e) => {
            if (!canvas.contains(e.relatedTarget)) {
                canvas.classList.remove('drag-over');
            }
        };

        const handleRootDrop = (e) => {
            e.preventDefault();
            canvas.classList.remove('drag-over');

            if (draggedBlockId) {
                // Re-parenting existing block to root
                State.updateBlockParent(draggedBlockId, null, dropIndex);
                State.setSelected(draggedBlockId);
                return;
            }

            const blockData = resolveDraggedBlockData(e.dataTransfer.getData('text/plain'));
            if (!blockData) return;
            const id = State.addBlock(blockData, dropIndex);
            if (typeof Palette !== 'undefined' && typeof Palette.finalizeAddedBlock === 'function') {
                Palette.finalizeAddedBlock(id, blockData);
            }
            State.setSelected(id);
        };

        [canvasWrapper, canvasFrame, canvas].forEach((rootTarget) => {
            if (!rootTarget) return;
            rootTarget.addEventListener('dragover', handleRootDragOver);
            rootTarget.addEventListener('dragleave', handleRootDragLeave);
            rootTarget.addEventListener('drop', handleRootDrop);
        });

        // Hide pen tool on click away
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.sf-pen-tool') && !e.target.closest('.block-content')) {
                hidePenTool();
            }
        });


        // ---- Click off to deselect ----
        canvas.addEventListener('click', (e) => {
            if (e.target === canvas) {
                State.setSelected(null);
            }
        });

        // ---- Block default actions during structure view ----
        canvas.addEventListener('click', (e) => {
            if (document.body.classList.contains('structure-view') && e.target.closest('.block-content')) {
                const interactive = e.target.closest('a, button, input, textarea, select, label, form, iframe, video, audio, img, [onclick]');
                if (interactive) {
                    const blockContent = interactive.closest('.block-content');
                    const handled = blockContent && typeof blockContent._sfSelectStructureTarget === 'function'
                        ? blockContent._sfSelectStructureTarget(e)
                        : false;
                    if (!handled) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }
            }
        }, true);

        // ---- State listeners ----
        State.on('blocksChanged', renderAll);
        State.on('blockUpdated', (id) => renderBlock(id));
        State.on('selectionChanged', updateSelection);
        State.on('subSelectionChanged', (path) => {
            if (!path || !document.body.classList.contains('structure-view')) {
                hidePenTool();
                return;
            }
            const blockId = State.getSelectedId();
            const blockEl = document.getElementById('block_' + blockId);
            if (blockEl) {
                const target = blockEl.querySelector(`[data-sf-path="${path}"]`);
                if (target) showPenTool(target, blockId, path);
            }
        });
        State.on('deviceChanged', (d) => {
            const frame = document.getElementById('canvasFrame');
            frame.classList.remove('tablet', 'mobile');
            if (d === 'tablet') frame.classList.add('tablet');
            if (d === 'mobile') frame.classList.add('mobile');
        });
    }
    function getDragAfterElement(container, x, y, selector = '.canvas-block') {
        const elements = [...container.querySelectorAll(`:scope > ${selector}:not(.dragging):not(.sf-sub-dragging)`)];

        return elements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;

            const dx = x - centerX;
            const dy = y - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // If we are to the left or above the center, we are "before" this element
            // But we actually want the element that is CLOSEST to us among those we are "before"
            // Wait, for reordering, it's better to find the closest element and check if we are on its left/right (or top/bottom)

            if (distance < closest.offset) {
                return { offset: distance, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.POSITIVE_INFINITY }).element;
    }

    function getBlockIndexFromEl(el) {
        const canvas = document.getElementById('canvas');
        const blocks = [...canvas.querySelectorAll('.canvas-block')];
        return blocks.indexOf(el);
    }

    function applyBlockActionsPosition(blockId, actionsEl) {
        const pos = floatingBlockActions[blockId];
        if (!actionsEl) return;
        if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
            actionsEl.classList.add('floating');
            actionsEl.style.left = pos.left + 'px';
            actionsEl.style.top = pos.top + 'px';
            actionsEl.style.right = 'auto';
        } else {
            actionsEl.classList.remove('floating');
            actionsEl.style.left = '';
            actionsEl.style.top = '';
            actionsEl.style.right = '';
        }
    }

    function executeBlockScripts(el) {
        if (!el) return;
        const scripts = el.querySelectorAll('script');
        scripts.forEach(oldScript => {
            const newScript = document.createElement('script');
            newScript.textContent = oldScript.textContent;
            document.body.appendChild(newScript);
            setTimeout(() => newScript.remove(), 500);
        });
    }

    function renderAll() {
        State.sanitize();
        const canvas = document.getElementById('canvas');
        canvas.innerHTML = '';
        const rootBlocks = State.getBlocks(null); // Get blocks with no parent

        const empty = document.createElement('div');
        empty.id = 'canvas-empty-state';
        empty.innerHTML = `<i class="fa-solid fa-hand-pointer fa-2xl"></i><p>Drag components from the left panel<br/>and drop them here to start building.</p>`;

        if (State.getAllBlocks().length === 0) {
            canvas.appendChild(empty);
            return;
        }

        rootBlocks.forEach(block => {
            try {
                const el = createBlockEl(block);
                canvas.appendChild(el);
                executeBlockScripts(el);
            } catch (e) {
                console.error(`Error rendering block ${block.id}:`, e);
            }
        });
        // Re-establish selection outline
        updateSelection(State.getSelectedId());
    }

    function renderBlock(id) {
        const el = document.getElementById('block_' + id);
        if (!el) { renderAll(); return; }
        const block = State.getBlock(id);
        if (!block) return;
        const newEl = createBlockEl(block);
        el.replaceWith(newEl);
        executeBlockScripts(newEl);
        if (State.getSelectedId() === id) newEl.classList.add('selected');
    }

    function createBlockEl(block) {
        const def = BlockTypes[block.type];
        if (!def) return document.createElement('div');

        const wrapper = document.createElement('div');
        wrapper.className = 'canvas-block';
        wrapper.id = 'block_' + block.id;
        wrapper.dataset.id = block.id;
        wrapper.dataset.type = block.type;

        // Block toolbar label
        const toolbar = document.createElement('div');
        toolbar.className = 'block-toolbar';
        toolbar.innerHTML = `<i class="${def.icon}" style="margin-right:4px;"></i>${def.label}`;

        // Block action buttons
        const actions = document.createElement('div');
        actions.className = 'block-actions';
        actions.innerHTML = `
      <button class="block-action-btn drag-handle" title="Drag to reorder" data-id="${block.id}"><i class="fa-solid fa-grip-vertical"></i></button>
      <button class="block-action-btn move-up" title="Move Up" data-id="${block.id}"><i class="fa-solid fa-arrow-up"></i></button>
      <button class="block-action-btn move-down" title="Move Down" data-id="${block.id}"><i class="fa-solid fa-arrow-down"></i></button>
      <button class="block-action-btn dup-btn" title="Duplicate" data-id="${block.id}"><i class="fa-solid fa-copy"></i></button>
      <button class="block-action-btn del-btn" title="Delete" data-id="${block.id}"><i class="fa-solid fa-trash"></i></button>
    `;
        applyBlockActionsPosition(block.id, actions);

        // Render preview HTML
        const content = document.createElement('div');
        content.className = 'block-content';
        content.style.pointerEvents = 'auto'; // Enable pointer events for sub-selection
        content.innerHTML = def.render(block.props);

        // Ensure inner element fills the wrapper but keeps its other styles
        const firstChild = content.firstElementChild;
        if (firstChild) {
            firstChild.style.width = '100%';
            if (block.props.animationPreset && block.props.animationPreset !== 'none' && (block.props.animationTrigger || 'load') === 'scroll') {
                firstChild.dataset.sfAnim = block.props.animationPreset;
                firstChild.dataset.sfAnimDuration = block.props.animationDuration || '0.8';
                firstChild.dataset.sfAnimDelay = block.props.animationDelay || '0';
            }
        }

        // --- Apply Layout Styles to Wrapper ---
        // This ensures the selection outline matches the actual block size 
        // and allows side-by-side layouts when width < 100%
        const p = block.props;
        wrapper.style.width = p.width || '100%';
        // Root wrapper should ALMOST ALWAYS be auto-height to allow content (like text) to grow
        wrapper.style.height = 'auto';
        wrapper.style.margin = p.margin || '0';
        wrapper.style.display = 'block'; // Essential for layout containers to work correctly

        // --- Sub-element Selection & Styling ---
        assignPathsAndStyles(content, block);
        const selectStructureTarget = (e) => {
            if (!document.body.classList.contains('structure-view')) return;

            // Find the best target path (bubble up to nearest repeater/dynamic if possible)
            let curr = e.target;
            let bestTarget = null;
            let bestPath = null;
            
            while (curr && curr !== content) {
                const p = curr.getAttribute('data-sf-path');
                if (p) {
                    bestTarget = curr;
                    bestPath = p;
                    // In most cases, we want the innermost one.
                    break; 
                }
                curr = curr.parentElement;
            }

            if (bestTarget && bestPath) {
                e.preventDefault();
                e.stopPropagation();
                State.setSelected(block.id);
                showPenTool(bestTarget, block.id, bestPath, e);
                State.setSelectedSubPath(bestPath); // Open properties panel immediately
                return true;
            }
            return false;
        };
        content._sfSelectStructureTarget = selectStructureTarget;
        content.addEventListener('click', (e) => {
            selectStructureTarget(e);
        });


        // --- Recursive Rendering for Nested Blocks ---
        const inner = getBlockChildHost(content);
        if (inner) {
                const hint = inner.querySelector('.sf-drop-hint');
                const children = State.getBlocks(block.id);
                if (children.length > 0) {
                    if (hint) hint.style.display = 'none';
                    children.forEach(child => {
                        inner.appendChild(createBlockEl(child));
                    });
                } else {
                    if (hint) hint.style.display = 'flex';
                }

                // Make the inner container a drop zone
                inner.style.pointerEvents = 'auto'; // Enable pointer events for drop zone
                inner.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    inner.style.background = 'rgba(108, 99, 255, 0.05)';
                    inner.style.border = '2px dashed var(--accent)';
                });
                inner.addEventListener('dragleave', () => {
                    inner.style.background = '';
                    inner.style.border = '';
                });
                inner.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    inner.style.background = '';
                    inner.style.border = '';

                    // Calculate drop index within this container
                    const afterEl = getDragAfterElement(inner, e.clientX, e.clientY);
                    const siblings = State.getBlocks(block.id);
                    let index = siblings.length; // Default to end
                    if (afterEl) {
                        const childId = afterEl.dataset.id;
                        index = siblings.findIndex(c => c.id === childId);
                    }

                    const rawPayload = e.dataTransfer.getData('text/plain');
                    const blockData = resolveDraggedBlockData(rawPayload);
                    const type = blockData?.type || (draggedBlockId ? State.getBlock(draggedBlockId).type : null);
                    if (!type || !BlockTypes[type]) return;

                    // Restriction: Don't allow sections or navbars to be nested inside containers
                    const targetDef = BlockTypes[type];
                    if (false) {
                        // Redirect to root level
                        if (draggedBlockId) {
                            State.updateBlockParent(draggedBlockId, null, null);
                        } else {
                            const newId = State.addBlock(blockData || {
                                type,
                                props: JSON.parse(JSON.stringify(targetDef.defaultProps))
                            }, null);
                            State.setSelected(newId);
                        }
                        showToast(`ℹ️ ${targetDef.label} must be at the root level (not nested).`, 'info');
                        return;
                    }

                    if (draggedBlockId) {
                        // Re-parenting existing block with index
                        State.updateBlockParent(draggedBlockId, block.id, index);
                        State.setSelected(draggedBlockId);
                        return;
                    }

                    // Add block as child of this container at specific index
                    const id = State.addBlock({
                        ...(blockData || {
                            type,
                            props: JSON.parse(JSON.stringify(BlockTypes[type].defaultProps))
                        }),
                        parentId: block.id
                    }, index);
                    if (typeof Palette !== 'undefined' && typeof Palette.finalizeAddedBlock === 'function') {
                        Palette.finalizeAddedBlock(id, blockData);
                    }
                    State.setSelected(id);
                });
        }


        // Resize handles
        const resizeHandleV = document.createElement('div');
        resizeHandleV.className = 'resize-handle-v';
        resizeHandleV.title = 'Drag to resize height';
        resizeHandleV.style.cssText = 'position:absolute; bottom:-3px; left:50%; transform:translateX(-50%); width:84px; height:6px; background:var(--accent); border-radius:999px; cursor:ns-resize; display:none; z-index:1001; border: 1px solid #fff;';

        const resizeHandleH = document.createElement('div');
        resizeHandleH.className = 'resize-handle-h';
        resizeHandleH.title = 'Drag to resize width';
        resizeHandleH.style.cssText = 'position:absolute; right:-3px; top:50%; transform:translateY(-50%); width:6px; height:84px; background:var(--accent); border-radius:999px; cursor:ew-resize; display:none; z-index:1001; border: 1px solid #fff;';

        const resizeHandleBoth = document.createElement('div');
        resizeHandleBoth.className = 'resize-handle-both';
        resizeHandleBoth.title = 'Drag to resize both width and height';
        resizeHandleBoth.style.cssText = 'position:absolute; right:-6px; bottom:-6px; width:12px; height:12px; background:var(--accent); border-radius:999px; cursor:nwse-resize; display:none; z-index:1002; border: 1px solid #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.3);';

        wrapper.appendChild(toolbar);
        wrapper.appendChild(actions);
        wrapper.appendChild(content);
        wrapper.appendChild(resizeHandleV);
        wrapper.appendChild(resizeHandleH);
        wrapper.appendChild(resizeHandleBoth);

        const selectBlockOnPointer = (e) => {
            if (e.target.closest('.block-actions, .block-toolbar, .resize-handle-v, .resize-handle-h, .resize-handle-both, .sf-pen-tool-container, .sf-sub-resize-handle')) {
                return;
            }
            State.setSelected(block.id);
        };

        wrapper.addEventListener('pointerdown', selectBlockOnPointer, true);

        // Vertical Resize (Height)
        let isResizingV = false;
        let startY, startHeight;

        resizeHandleV.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            isResizingV = true;
            startY = e.clientY;

            // We want to resize the media/container, not the outer wrapper
            const inner = content.querySelector('figure, .video-container, hr, .sf-container-block .container-inner, .sf-box-block .container-inner') || content.firstElementChild || content.firstChild;
            if (!inner || !inner.style) return;
            startHeight = inner.offsetHeight;

            document.body.style.cursor = 'ns-resize';

            const onMove = (me) => {
                if (!isResizingV) return;
                const delta = me.clientY - startY;
                const newVal = Math.max(20, startHeight + delta);

                const videoCont = inner.querySelector('.video-container') || (inner.classList.contains('video-container') ? inner : null);
                if (videoCont) {
                    videoCont.style.paddingBottom = '0';
                    videoCont.style.height = newVal + 'px';
                } else {
                    inner.style.height = newVal + 'px';
                }
                inner.style.maxHeight = 'none';
            };
            const onUp = (ue) => {
                isResizingV = false;
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const delta = ue.clientY - startY;
                const newVal = Math.max(20, startHeight + delta);

                State.updateBlockProps(block.id, { height: newVal + 'px', maxHeight: 'none', aspectRatio: '0' });
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Horizontal Resize (Width)
        let isResizingH = false;
        let startX, startWidth;

        resizeHandleH.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            isResizingH = true;
            startX = e.clientX;
            // Get the current width of the wrapper block
            startWidth = wrapper.offsetWidth;
            document.body.style.cursor = 'ew-resize';

            // Find elements that restrict width to remove their max-width
            const limiters = content.querySelectorAll('[style*="max-width"]');
            limiters.forEach(el => el.style.maxWidth = 'none');
            const inner = content.firstElementChild || content.firstChild;
            if (inner && inner.style) inner.style.maxWidth = 'none';

            const onMove = (me) => {
                if (!isResizingH) return;
                const delta = me.clientX - startX;

                const style = window.getComputedStyle(wrapper);
                const isMarginCentered = style.marginLeft !== '0px' && style.marginRight !== '0px' && style.marginLeft === style.marginRight;
                const multiplier = isMarginCentered ? 2 : 1;

                const newVal = Math.max(50, startWidth + delta * multiplier);

                // Change the wrapper width directly for smooth visual updates
                wrapper.style.width = newVal + 'px';
            };
            const onUp = (ue) => {
                isResizingH = false;
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                const delta = ue.clientX - startX;
                const style = window.getComputedStyle(wrapper);
                const isMarginCentered = style.marginLeft !== '0px' && style.marginRight !== '0px' && style.marginLeft === style.marginRight;
                const multiplier = isMarginCentered ? 2 : 1;
                const newVal = Math.max(50, startWidth + delta * multiplier);

                const containerWidth = wrapper.parentElement ? wrapper.parentElement.offsetWidth : 1200;
                let percent = Math.min(100, (newVal / containerWidth) * 100);
                percent = Math.max(5, percent); // prevent visually disappearing fully

                State.updateBlockProps(block.id, {
                    width: percent.toFixed(2) + '%',
                    maxWidth: 'none'
                });
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Dual Axis Resize (Width & Height)
        let isResizingBoth = false;
        let startBothX, startBothY, startBothWidth, startBothHeight;

        resizeHandleBoth.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            isResizingBoth = true;
            startBothX = e.clientX;
            startBothY = e.clientY;

            // Width tracks wrapper for smoothness
            startBothWidth = wrapper.offsetWidth;

            // Focus height purely on the media/inner content
            const inner = content.querySelector('figure, .video-container, hr, .sf-container-block .container-inner, .sf-box-block .container-inner') || content.firstElementChild || content.firstChild;
            if (!inner || !inner.style) return;
            startBothHeight = inner.offsetHeight;

            // Remove max-width constraints so drag feels smooth immediately
            const limiters = content.querySelectorAll('[style*="max-width"]');
            limiters.forEach(el => el.style.maxWidth = 'none');

            document.body.style.cursor = 'nwse-resize';

            const onMove = (me) => {
                if (!isResizingBoth) return;
                const deltaX = me.clientX - startBothX;
                const deltaY = me.clientY - startBothY;

                const style = window.getComputedStyle(wrapper);
                const isMarginCentered = style.marginLeft !== '0px' && style.marginRight !== '0px' && style.marginLeft === style.marginRight;
                const multiplier = isMarginCentered ? 2 : 1;

                const newWidth = Math.max(50, startBothWidth + deltaX * multiplier);
                const newHeight = Math.max(50, startBothHeight + deltaY);

                // Update wrapper width
                wrapper.style.width = newWidth + 'px';

                // Update INNER height specifically
                const videoCont = inner.querySelector('.video-container') || (inner.classList.contains('video-container') ? inner : null);
                if (videoCont) {
                    videoCont.style.paddingBottom = '0';
                    videoCont.style.height = newHeight + 'px';
                } else {
                    inner.style.height = newHeight + 'px';
                }
                inner.style.maxHeight = 'none';
            };
            const onUp = (ue) => {
                isResizingBoth = false;
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                const deltaX = ue.clientX - startBothX;
                const deltaY = ue.clientY - startBothY;

                const style = window.getComputedStyle(wrapper);
                const isMarginCentered = style.marginLeft !== '0px' && style.marginRight !== '0px' && style.marginLeft === style.marginRight;
                const multiplier = isMarginCentered ? 2 : 1;

                const newWidth = Math.max(50, startBothWidth + deltaX * multiplier);
                const newHeight = Math.max(50, startBothHeight + deltaY);

                const containerWidth = wrapper.parentElement ? wrapper.parentElement.offsetWidth : 1200;
                let percent = Math.min(100, (newWidth / containerWidth) * 100);
                percent = Math.max(5, percent);

                State.updateBlockProps(block.id, {
                    width: percent.toFixed(2) + '%',
                    height: newHeight + 'px',
                    maxWidth: 'none',
                    maxHeight: 'none',
                    aspectRatio: '0'
                });
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Events
        wrapper.addEventListener('click', (e) => {
            e.stopPropagation();
            State.setSelected(block.id);
        });

        wrapper.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            State.setSelected(block.id);
            showContextMenu(e.clientX, e.clientY, block.id);
        });

        // Drag handle for reordering
        const dragHandle = actions.querySelector('.drag-handle');
        dragHandle.addEventListener('mousedown', () => {
            wrapper.draggable = true;
            draggedBlockId = block.id;
        });
        wrapper.addEventListener('dragstart', (e) => {
            if (!draggedBlockId) { e.preventDefault(); return; }
            wrapper.classList.add('dragging');
            e.dataTransfer.setData('text/plain', '');
            e.dataTransfer.effectAllowed = 'move';
        });
        wrapper.addEventListener('dragend', () => {
            wrapper.draggable = false;
            wrapper.classList.remove('dragging');
            draggedBlockId = null;
        });
        wrapper.addEventListener('dragover', (e) => {
            // Intercept for both block reordering AND palette drags
            if (draggedBlockId === block.id) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = wrapper.getBoundingClientRect();
            // Determine if element sits in a horizontal row or vertical stack
            const isHorizontal = wrapper.parentElement ? window.getComputedStyle(wrapper.parentElement).flexDirection === 'row' : false;
            
            const isFirstHalf = isHorizontal 
                ? (e.clientX < rect.left + rect.width / 2)
                : (e.clientY < rect.top + rect.height / 2);

            if (isFirstHalf) {
                wrapper.style.boxShadow = isHorizontal ? 'inset 4px 0 0 #6c63ff' : 'inset 0 4px 0 #6c63ff';
            } else {
                wrapper.style.boxShadow = isHorizontal ? 'inset -4px 0 0 #6c63ff' : 'inset 0 -4px 0 #6c63ff';
            }
        });
        wrapper.addEventListener('dragleave', () => {
            wrapper.style.boxShadow = '';
        });
        wrapper.addEventListener('drop', (e) => {
            wrapper.style.boxShadow = '';

            if (draggedBlockId === block.id) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = wrapper.getBoundingClientRect();
            const isHorizontal = wrapper.parentElement ? window.getComputedStyle(wrapper.parentElement).flexDirection === 'row' : false;
            const insertAfter = isHorizontal 
                ? (e.clientX >= rect.left + rect.width / 2)
                : (e.clientY >= rect.top + rect.height / 2);
            
            const toBlock = State.getBlock(block.id);
            const siblings = State.getBlocks(toBlock.parentId);
            let siblingIdx = siblings.findIndex(s => s.id === block.id);
            if (insertAfter) siblingIdx++;

            if (draggedBlockId) {
                State.updateBlockParent(draggedBlockId, toBlock.parentId, siblingIdx);
                State.setSelected(draggedBlockId);
            } else {
                const blockData = resolveDraggedBlockData(e.dataTransfer.getData('text/plain'));
                const type = blockData?.type;
                if (!type || !BlockTypes[type]) return;
                
                const targetDef = BlockTypes[type];
                if (false) {
                    showToast(`ℹ️ ${targetDef.label} must be at the root level (not nested).`, 'info');
                    return;
                }
                
                const newId = State.addBlock({
                    ...(blockData || {
                        type,
                        props: JSON.parse(JSON.stringify(targetDef.defaultProps))
                    }),
                    parentId: toBlock.parentId
                }, siblingIdx);
                State.setSelected(newId);
            }
        });


        // Action button events
        actions.querySelector('.move-up').addEventListener('click', (e) => {
            e.stopPropagation(); State.moveBlock(block.id, 'up');
        });
        actions.querySelector('.move-down').addEventListener('click', (e) => {
            e.stopPropagation(); State.moveBlock(block.id, 'down');
        });
        actions.querySelector('.dup-btn').addEventListener('click', (e) => {
            e.stopPropagation(); State.duplicateBlock(block.id);
        });
        actions.querySelector('.del-btn').addEventListener('click', (e) => {
            e.stopPropagation(); State.removeBlock(block.id);
        });

        return wrapper;
    }




    function updateSelection(id) {
        document.querySelectorAll('.canvas-block').forEach(el => el.classList.remove('selected'));
        document.querySelectorAll('.block-actions').forEach((actionsEl) => {
            const blockId = actionsEl.closest('.canvas-block')?.dataset.id;
            if (!blockId) return;
            if (id && blockId === String(id)) applyBlockActionsPosition(blockId, actionsEl);
            else if (!floatingBlockActions[blockId]) applyBlockActionsPosition(blockId, actionsEl);
        });
        if (id) {
            const el = document.getElementById('block_' + id);
            if (el) el.classList.add('selected');
        }
    }

    // ---- Context Menu ----
    let ctxTarget = null;

    function showContextMenu(x, y, id) {
        ctxTarget = id;
        const menu = document.getElementById('contextMenu');
        menu.classList.remove('hidden');
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }

    function hideContextMenu() {
        document.getElementById('contextMenu').classList.add('hidden');
        ctxTarget = null;
    }

    function initContextMenu() {
        document.addEventListener('click', hideContextMenu);
        document.getElementById('ctxMoveUp').addEventListener('click', () => { if (ctxTarget) State.moveBlock(ctxTarget, 'up'); });
        document.getElementById('ctxMoveDown').addEventListener('click', () => { if (ctxTarget) State.moveBlock(ctxTarget, 'down'); });
        document.getElementById('ctxDuplicate').addEventListener('click', () => { if (ctxTarget) State.duplicateBlock(ctxTarget); });
        document.getElementById('ctxDelete').addEventListener('click', () => { if (ctxTarget) State.removeBlock(ctxTarget); });
    }

    // ---- Sub-element Helpers ----
    function assignPathsAndStyles(container, block) {
        const subStyles = block.props.subStyles || {};

        function recurse(el, requestedPath) {
            const existingPath = el.getAttribute('data-sf-path');
            const path = existingPath || requestedPath;
            el.setAttribute('data-sf-path', path);
            const s = subStyles[path] || {};

            // Re-apply selection class if this is the active sub-path
            if (State.getSelectedSubPath() === path) {
                el.classList.add('sf-sub-selected');
                // We might need to reposition the pen tool if it's already there
                if (currentPenTool && currentPenTool.target !== el) {
                    currentPenTool.target = el;
                }
            } else {
                el.classList.remove('sf-sub-selected');
            }

            if (!isVoidElement(el)) {
                el.draggable = true;
                el.addEventListener('dragstart', (e) => {
                    const normalizedPath = ensurePromoted(block.id, path);
                    draggedSubElement = { blockId: block.id, path: normalizedPath };
                    el.classList.add('sf-sub-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', `sf-sub:${block.id}:${normalizedPath}`);
                    State.setSelected(block.id);
                    State.setSelectedSubPath(normalizedPath);
                });
                el.addEventListener('dragend', () => {
                    el.classList.remove('sf-sub-dragging');
                    draggedSubElement = null;
                });
            }

            if (canHostSubElements(el)) {
                el.addEventListener('dragover', (e) => {
                    if (!draggedSubElement) return;
                    e.preventDefault();
                    e.stopPropagation();
                    el.style.setProperty('outline', '2px dashed var(--accent)', 'important');
                    el.style.setProperty('outline-offset', '2px', 'important');
                });
                el.addEventListener('dragleave', () => {
                    if (!draggedSubElement) return;
                    if (s.visualGuide && s.visualGuide !== 'none') return;
                    el.style.removeProperty('outline');
                    el.style.removeProperty('outline-offset');
                });
                el.addEventListener('drop', (e) => {
                    if (!draggedSubElement) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!(s.visualGuide && s.visualGuide !== 'none')) {
                        el.style.removeProperty('outline');
                        el.style.removeProperty('outline-offset');
                    }
                    handleSubElementDrop(block.id, path);
                });
            }

            // Apply sub-styles if any
            if (Object.keys(s).length > 0) {
                const clean = (val) => (val && typeof val === 'string') ? val.replace(' !important', '').trim() : val;
                // Layout
                if (s.display) el.style.setProperty('display', clean(s.display), 'important');
                if (s.width) el.style.setProperty('width', clean(s.width), 'important');
                if (s.height) el.style.setProperty('height', clean(s.height), 'important');
                if (s.minWidth) el.style.setProperty('min-width', clean(s.minWidth), 'important');
                if (s.minHeight) el.style.setProperty('min-height', clean(s.minHeight), 'important');
                if (s.maxWidth) el.style.setProperty('max-width', clean(s.maxWidth), 'important');
                if (s.maxHeight) el.style.setProperty('max-height', clean(s.maxHeight), 'important');
                if (s.margin) el.style.setProperty('margin', clean(s.margin), 'important');
                if (s.padding) el.style.setProperty('padding', clean(s.padding), 'important');
                if (s.gap) el.style.setProperty('gap', clean(s.gap), 'important');
                if (s.direction) el.style.setProperty('flex-direction', clean(s.direction), 'important');
                if (s.justify) el.style.setProperty('justify-content', clean(s.justify), 'important');
                if (s.align) el.style.setProperty('align-items', clean(s.align), 'important');
                if (s.flexGrow) el.style.setProperty('flex-grow', clean(s.flexGrow), 'important');
                if (s.flexShrink) el.style.setProperty('flex-shrink', clean(s.flexShrink), 'important');
                if (s.alignSelf) el.style.setProperty('align-self', clean(s.alignSelf), 'important');

                // Typography
                if (s.color) el.style.setProperty('color', clean(s.color), 'important');
                if (s.fontSize) el.style.setProperty('font-size', clean(s.fontSize), 'important');
                if (s.fontWeight) el.style.setProperty('font-weight', clean(s.fontWeight), 'important');
                if (s.fontFamily) el.style.setProperty('font-family', clean(s.fontFamily), 'important');
                if (s.lineHeight) el.style.setProperty('line-height', clean(s.lineHeight), 'important');
                if (s.letterSpacing) el.style.setProperty('letter-spacing', clean(s.letterSpacing), 'important');
                if (s.textAlign) el.style.setProperty('text-align', clean(s.textAlign), 'important');

                // Visuals
                if (s.bgColor) el.style.setProperty('background-color', clean(s.bgColor), 'important');
                if (s.background) el.style.setProperty('background', clean(s.background), 'important');
                if (s.opacity) el.style.setProperty('opacity', clean(s.opacity), 'important');
                if (s.zIndex) el.style.setProperty('z-index', clean(s.zIndex), 'important');
                if (s.boxShadow) el.style.setProperty('box-shadow', clean(s.boxShadow), 'important');
                if (s.borderRadius) el.style.setProperty('border-radius', clean(s.borderRadius), 'important');
                if (s.border) el.style.setProperty('border', clean(s.border), 'important');
                if (s.borderWidth) el.style.setProperty('border-width', clean(s.borderWidth), 'important');
                if (s.borderStyle) el.style.setProperty('border-style', clean(s.borderStyle), 'important');
                if (s.borderColor) el.style.setProperty('border-color', clean(s.borderColor), 'important');

                // Effects
                if (s.opacity !== undefined) el.style.setProperty('opacity', clean(s.opacity), 'important');
                if (s.blur) el.style.setProperty('filter', `blur(${clean(s.blur)}px)`, 'important');

                // Visual Guide (Editor Only)
                if (s.visualGuide && s.visualGuide !== 'none') {
                    const color = s.visualGuide === 'red' ? '#ff4d4d' : '#2ecc71';
                    el.style.setProperty('outline', `3px dashed ${color}`, 'important');
                    el.style.setProperty('outline-offset', '-3px', 'important');
                }

                // Flexbox (Sub-elements)
                if (s.flexGrow !== undefined) el.style.setProperty('flex-grow', clean(s.flexGrow), 'important');
                if (s.flexShrink !== undefined) el.style.setProperty('flex-shrink', clean(s.flexShrink), 'important');

                const tagName = el.tagName.toUpperCase();
                // Behavior / Content
                const isContentTag = ['P', 'SPAN', 'X', 'A', 'BUTTON', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'LABEL', 'I'].includes(tagName);
                if (s.text !== undefined && (el.children.length === 0 || isContentTag)) {
                    el.innerText = s.text;
                }
                if (s.customId) el.id = s.customId;
                if (s.customClass) el.className = s.customClass;

                // Handle Actions (Link / Cart)
                if (tagName === 'A' || tagName === 'BUTTON' || (el && el.classList.contains('sf-button')) || (el && el.classList.contains('nav-btn'))) {
                    if (s.actionType === 'cart') {
                        el.setAttribute('data-name', s.cartItemName || 'Product');
                        el.setAttribute('data-price', s.cartItemPrice || '0.00');
                        el.setAttribute('data-image', s.cartItemImage || '');
                        el.onclick = (e) => {
                            if (window.Cart) {
                                window.Cart.add({
                                    name: el.getAttribute('data-name'),
                                    price: el.getAttribute('data-price'),
                                    image: el.getAttribute('data-image')
                                }, el);
                            }
                            e.stopPropagation();
                        };
                    } else if (s.href !== undefined) {
                      if (tagName === 'A') el.href = s.href;
                    }
                }
            }


            // 1. Render Dynamic children (from subStyles)
            if (s.children && s.children.length > 0) {
                s.children.forEach((childData, i) => {
                    const childPath = path + '.c' + i;
                    const cs = subStyles[childPath] || {};
                    let childEl = createDynamicElement(childData, cs, block);
                    el.appendChild(childEl);
                    recurse(childEl, childPath);
                });
            }

            // 2. Assign paths to Template children (that weren't just added)
            const isPromoted = s.templatePromoted;
            Array.from(el.children).forEach((child, i) => {
                const existingPath = child.getAttribute('data-sf-path');
                if (existingPath && existingPath.includes('.c')) return;
                
                if (isPromoted) {
                    child.style.display = 'none'; // Hide the original template part
                    return;
                }
                
                recurse(child, path + '.t' + i);
            });
        }

        Array.from(container.children).forEach((child, i) => {
            recurse(child, i.toString());
        });

        // Root level dynamic children
        if (subStyles.children && subStyles.children.length > 0) {
            subStyles.children.forEach((childData, i) => {
                const childPath = 'c' + i;
                const cs = subStyles[childPath] || {};
                let childEl = createDynamicElement(childData, cs, block);
                container.appendChild(childEl);
                recurse(childEl, childPath);
            });
        }
    }

    function createDynamicElement(childData, cs, block) {
        let childEl;
        const type = childData.type;

        if (type === 'img') {
            childEl = document.createElement('img');
            childEl.src = cs.src || childData.props.src || '';
            childEl.style.maxWidth = '100%';
        } else if (type === 'video') {
            const cont = document.createElement('div');
            cont.className = 'video-container';
            cont.style.cssText = 'position:relative;padding-bottom:56.25%;height:0;overflow:hidden;';
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;';
            iframe.src = VideoHelper.getEmbedUrl(cs.src || childData.props.src || '');
            cont.appendChild(iframe);
            childEl = cont;
        } else if (type === 'button' || type === 'add-to-cart') {
            childEl = document.createElement('button');
            childEl.className = type === 'add-to-cart' ? 'sf-add-to-cart' : 'nav-btn';
            childEl.innerText = cs.text || childData.props.text || (type === 'add-to-cart' ? 'Add to Cart' : 'Button');
            childEl.style.cssText = 'padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:6px;';
        } else if (type === 'div' && !childData.props.html) {
            childEl = document.createElement('div');
            childEl.style.cssText = 'min-height:50px;width:100%;background:rgba(0,0,0,0.02);border:1px dashed #ccc;padding:10px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;';
        } else {
            // Generic html tag support (h2, p, a, div with html, etc)
            childEl = document.createElement(type || 'p');
            // Restore inner HTML or text
            if (childData.props.html) {
                childEl.innerHTML = childData.props.html;
            } else {
                childEl.innerText = cs.text || childData.props.text || 'New text...';
            }
            if (type === 'a' && childData.props.href) {
                childEl.href = childData.props.href;
            }
        }
        
        // Only apply default margins to components that aren't promoted from templates
        if (!childData.promoted) {
            childEl.style.margin = '10px 0';
            childEl.style.display = 'block';
        }
        
        return childEl;
    }

    function isDescendantPath(parentPath, childPath) {
        return !!parentPath && !!childPath && childPath.startsWith(parentPath + '.');
    }

    function handleSubElementDrop(targetBlockId, targetPath) {
        if (!draggedSubElement) return;

        const sourceBlockId = draggedSubElement.blockId;
        const sourcePath = ensurePromoted(sourceBlockId, draggedSubElement.path);
        const normalizedTargetPath = ensurePromoted(targetBlockId, targetPath);
        if (!normalizedTargetPath) return;
        if (sourceBlockId === targetBlockId && (sourcePath === normalizedTargetPath || isDescendantPath(sourcePath, normalizedTargetPath))) {
            return;
        }

        const targetBlock = State.getBlock(targetBlockId);
        if (!targetBlock) return;
        if (!targetBlock.props.subStyles) targetBlock.props.subStyles = {};
        const targetParent = normalizedTargetPath === ''
            ? targetBlock.props.subStyles
            : (targetBlock.props.subStyles[normalizedTargetPath] = targetBlock.props.subStyles[normalizedTargetPath] || {});
        const insertIndex = Array.isArray(targetParent.children) ? targetParent.children.length : 0;

        if (sourceBlockId === targetBlockId) {
            State.moveSubElementToNewParent(targetBlockId, sourcePath, normalizedTargetPath, insertIndex);
        } else {
            State.moveSubElementBetweenBlocks(sourceBlockId, sourcePath, targetBlockId, normalizedTargetPath, insertIndex);
        }
    }

    function snapshotElementForMove(el) {
        if (!el || !el.tagName) return null;
        const tag = el.tagName.toLowerCase();
        const style = window.getComputedStyle(el);
        const childStyle = {
            display: style.display,
            margin: style.margin,
            padding: style.padding,
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            background: style.background,
            borderRadius: style.borderRadius,
            border: style.border,
            width: el.style.width || '',
            height: el.style.height || ''
        };

        const props = {
            html: el.innerHTML,
            text: el.innerText,
            src: el.getAttribute('src') || '',
            href: el.getAttribute('href') || ''
        };

        if (tag === 'img') {
            return { childData: { type: 'img', props: { src: props.src } }, childStyle };
        }
        if (tag === 'iframe') {
            return { childData: { type: 'video', props: { src: el.getAttribute('src') || '' } }, childStyle };
        }
        if (tag === 'button') {
            return { childData: { type: 'button', props: { text: props.text } }, childStyle };
        }

        return { childData: { type: tag, props }, childStyle };
    }

    function clearSubDropTarget() {
        if (activeSubDropTarget) {
            activeSubDropTarget.classList.remove('sf-sub-drop-zone');
            activeSubDropTarget = null;
        }
    }

    function startToolbarSubDrag(blockId, path, sourceTarget, toolbarEl, startEvent) {
        const normalizedPath = ensurePromoted(blockId, path);
        draggedSubElement = { blockId, path: normalizedPath };
        State.setSelected(blockId);
        State.setSelectedSubPath(normalizedPath);

        const ghost = document.createElement('div');
        ghost.className = 'sf-drag-ghost';
        ghost.textContent = 'Moving element';
        ghost.style.cssText = `
            position: fixed;
            left: ${startEvent.clientX + 14}px;
            top: ${startEvent.clientY + 14}px;
            background: rgba(17, 24, 39, 0.95);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 999px;
            padding: 8px 12px;
            font-size: 12px;
            font-weight: 600;
            z-index: 5000;
            pointer-events: none;
            box-shadow: 0 10px 30px rgba(0,0,0,0.25);
        `;
        document.body.appendChild(ghost);

        if (toolbarEl) toolbarEl.style.pointerEvents = 'none';
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';

        const onMove = (moveEvent) => {
            ghost.style.left = `${moveEvent.clientX + 14}px`;
            ghost.style.top = `${moveEvent.clientY + 14}px`;

            clearSubDropTarget();
            const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
            const candidate = el && el.closest ? el.closest('[data-sf-path]') : null;
            if (!candidate || !canHostSubElements(candidate)) return;

            const blockEl = candidate.closest('.canvas-block');
            if (!blockEl) return;
            const candidateBlockId = blockEl.dataset.id;
            const candidatePath = candidate.getAttribute('data-sf-path');
            if (!candidatePath) return;

            const sameElement = candidateBlockId === blockId && candidatePath === normalizedPath;
            const insideDragged = candidateBlockId === blockId && isDescendantPath(normalizedPath, candidatePath);
            if (sameElement || insideDragged) return;

            candidate.classList.add('sf-sub-drop-zone');
            activeSubDropTarget = candidate;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            if (toolbarEl) toolbarEl.style.pointerEvents = '';
            ghost.remove();

            if (activeSubDropTarget) {
                const blockEl = activeSubDropTarget.closest('.canvas-block');
                const targetBlockId = blockEl?.dataset.id;
                const targetPath = activeSubDropTarget.getAttribute('data-sf-path');
                clearSubDropTarget();
                if (targetBlockId && targetPath) {
                    const snapshot = snapshotElementForMove(sourceTarget);
                    if (snapshot) {
                        const normalizedTargetPath = ensurePromoted(targetBlockId, targetPath);
                        const newPath = State.appendSubElement(targetBlockId, normalizedTargetPath, snapshot.childData, snapshot.childStyle);
                        if (newPath) {
                            State.hideSubElement(blockId, normalizedPath);
                            State.setSelected(targetBlockId);
                            State.setSelectedSubPath(newPath);
                        }
                    }
                }
            } else {
                clearSubDropTarget();
            }

            draggedSubElement = null;
            activeSubDrag = null;
        };

        activeSubDrag = { onMove, onUp, ghost };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    let currentPenTool = null;

    function showPenTool(target, blockId, path, e = null) {
        if (!document.body.classList.contains('structure-view')) {
            hidePenTool();
            return;
        }
        hidePenTool();

        // Visual selection on target
        target.classList.add('sf-sub-selected');

        // Create Sub-element Resize Handles
        createSubResizeHandles(target, blockId, path);

        const rect = target.getBoundingClientRect();
        
        let topPos = rect.top - 12;
        let leftPos = rect.right - 12; // Fallback to right edge for small things
        
        // If we have mouse coordinates, use them (much better for wide blocks)
        if (e) {
            topPos = e.clientY - 45;
            leftPos = e.clientX - 15;
        }
        
        // Clamp to ensure the popup stays fully on-screen
        topPos = Math.max(10, topPos);
        leftPos = Math.min(window.innerWidth - 200, Math.max(10, leftPos));

        // Create container for buttons
        const container = document.createElement('div');
        container.className = 'sf-pen-tool-container';
        container.style.cssText = `
            position: fixed;
            top: ${topPos}px;
            left: ${leftPos}px;
            display: flex;
            gap: 4px;
            z-index: 3000;
            pointer-events: auto;
            background: black;
            
            border-radius: 12px;
            
        `;

        const isDynamic = path.includes('c'); // Path contains c (e.g. 0.c0 or c0)

        // Helper to create buttons
        const createBtn = (icon, title, color, onClick) => {
            const btn = document.createElement('button');
            btn.className = 'sf-pen-tool';
            btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
            btn.title = title;
            btn.style.cssText = `
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: ${color};
                color: #fff;
                border: 2px solid #fff;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content:center;
                font-size: 0.8rem;
                transition: background 0.2s, box-shadow 0.2s;
            `;
            btn.onclick = (e) => {
                e.stopPropagation();
                onClick();
            };
            return btn;
        };

        // --- Manipulation Helpers ---
        function handleAction(actionFn) {
            const newPath = ensurePromoted(blockId, path);
            if (actionFn(blockId, newPath)) {
                // If path changed due to promotion, we might need a re-sync
                // but blockUpdate will handle it.
            }
        }

        function selectPath(nextPath) {
            if (!nextPath) return;
            State.setSelected(blockId);
            State.setSelectedSubPath(nextPath);
        }

        function getParentPath() {
            const parentEl = target.parentElement?.closest?.('[data-sf-path]');
            return parentEl ? parentEl.getAttribute('data-sf-path') : null;
        }

        function getChildPath() {
            const childEl = target.querySelector?.('[data-sf-path]');
            return childEl ? childEl.getAttribute('data-sf-path') : null;
        }

        // 1. Drag Button
        const dragBtn = document.createElement('div');
        dragBtn.className = 'sf-pen-tool sf-pen-tool-drag';
        dragBtn.innerHTML = '<i class="fa-solid fa-grip-lines"></i>';
        dragBtn.title = 'Drag this element';
        dragBtn.style.cssText = `
            width: 34px;
            height: 34px;
            border-radius: 50%;
            background: #111827;
            color: #fff;
            border: 2px solid #fff;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            cursor: grab;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.9rem;
            user-select: none;
        `;
        dragBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        dragBtn.addEventListener('mousedown', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            startToolbarSubDrag(blockId, path, target, container, evt);
        });
        container.appendChild(dragBtn);

        // 2. Up Button
        container.appendChild(createBtn('fa-arrow-up', 'Move Up', '#6c63ff', () => {
            handleAction((bid, p) => State.moveSubElement(bid, p, 'up'));
        }));

        // 3. Down Button
        container.appendChild(createBtn('fa-arrow-down', 'Move Down', '#6c63ff', () => {
            handleAction((bid, p) => State.moveSubElement(bid, p, 'down'));
        }));

        // 4. Copy Button
        container.appendChild(createBtn('fa-copy', 'Duplicate', '#2ecc71', () => {
            handleAction((bid, p) => State.duplicateSubElement(bid, p));
        }));

        // 5. Parent Select Button
        container.appendChild(createBtn('fa-level-up-alt', 'Select parent element', '#f59e0b', () => {
            const parentPath = getParentPath();
            if (!parentPath) {
                if (window.showToast) window.showToast('No parent element found for this selection.', 'info');
                return;
            }
            selectPath(parentPath);
        }));

        // 6. Child Select Button
        container.appendChild(createBtn('fa-level-down-alt', 'Select first child element', '#06b6d4', () => {
            const childPath = getChildPath();
            if (!childPath) {
                if (window.showToast) window.showToast('No child element found inside this selection.', 'info');
                return;
            }
            selectPath(childPath);
        }));

        // 7. Delete Button (for ALL)
        container.appendChild(createBtn('fa-trash', 'Delete this element', '#ff4d4d', () => {
            if (confirm('Delete this element?')) {
                const newPath = ensurePromoted(blockId, path);
                State.removeSubElement(blockId, newPath);
                showToast('Element deleted.', 'info');
            }
        }));

        document.body.appendChild(container);

        currentPenTool = { el: container, target: target, path: path };
    }

    // Reposition pen tool on scroll/resize or re-render
    function updatePenToolPosition() {
        if (!document.body.classList.contains('structure-view')) {
            hidePenTool();
            return;
        }
        if (currentPenTool && currentPenTool.target) {
            const rect = currentPenTool.target.getBoundingClientRect();
            currentPenTool.el.style.top = `${rect.top - 12}px`;
            currentPenTool.el.style.left = `${rect.right - 12}px`;
        }
    }

    window.addEventListener('scroll', updatePenToolPosition, true);
    window.addEventListener('resize', updatePenToolPosition);
    State.on('blockUpdated', () => setTimeout(updatePenToolPosition, 0)); // Delay slightly to ensure DOM is ready

    function hidePenTool() {
        if (currentPenTool) {
            currentPenTool.el.remove();
            if (currentPenTool.target) {
                currentPenTool.target.classList.remove('sf-sub-selected');
                // Remove resize handles
                const handles = currentPenTool.target.querySelectorAll('.sf-sub-resize-handle');
                handles.forEach(h => h.remove());
            }
            currentPenTool = null;
        }
    }

    function createSubResizeHandles(target, blockId, path) {
        if (!document.body.classList.contains('structure-view')) return;
        // Remove existing handles if any
        target.querySelectorAll('.sf-sub-resize-handle').forEach(h => h.remove());

        const createHandle = (type) => {
            const h = document.createElement('div');
            h.className = 'sf-sub-resize-handle sf-sub-resize-' + type;
            let style = 'position:absolute; background:var(--accent); z-index:2000; border:1px solid #fff; pointer-events:auto;';
            if (type === 'v') style += 'height:6px; left:0; right:0; bottom:-3px; cursor:ns-resize; border-radius:999px;';
            if (type === 'h') style += 'width:6px; top:0; bottom:0; right:-3px; cursor:ew-resize; border-radius:999px;';
            if (type === 'both') style += 'width:10px; height:10px; right:-5px; bottom:-5px; cursor:nwse-resize; border-radius:999px;';
            h.style.cssText = style;
            
            h.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                const startX = e.clientX;
                const startY = e.clientY;
                const rect = target.getBoundingClientRect();
                const startW = rect.width;
                const startH = rect.height;

                const onMove = (me) => {
                    const dx = me.clientX - startX;
                    const dy = me.clientY - startY;
                    if (type === 'h' || type === 'both') target.style.width = (startW + dx) + 'px';
                    if (type === 'v' || type === 'both') target.style.height = (startH + dy) + 'px';
                };
                const onUp = (ue) => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    const dx = ue.clientX - startX;
                    const dy = ue.clientY - startY;
                    const finalW = (startW + dx) + 'px';
                    const finalH = (startH + dy) + 'px';
                    
                    const updates = {};
                    if (type === 'h' || type === 'both') updates.width = finalW;
                    if (type === 'v' || type === 'both') updates.height = finalH;
                    
                    State.updateSubStyle(blockId, path, updates);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            return h;
        };

        // Ensure target has relative/absolute position so handles work
        if (window.getComputedStyle(target).position === 'static') {
            target.style.position = 'relative';
        }

        target.appendChild(createHandle('v'));
        target.appendChild(createHandle('h'));
        target.appendChild(createHandle('both'));
    }

    function ensurePromoted(blockId, path) {
        const block = State.getBlock(blockId);
        if (!block) return path;

        if (/^\d+$/.test(path)) {
            const blockEl = document.getElementById('block_' + blockId);
            if (!blockEl) return path;

            const parentEl = blockEl.querySelector('.block-content');
            if (!parentEl) return path;

            const children = Array.from(parentEl.children).map(child => {
                const tagName = child.tagName.toLowerCase();
                return {
                    type: tagName,
                    promoted: true,
                    props: {
                        html: child.innerHTML,
                        src: child.src || '',
                        href: child.href || '',
                        text: child.innerText
                    }
                };
            });

            Array.from(parentEl.children).forEach((child, idx) => {
                const newChildPath = `c${idx}`;
                if (!block.props.subStyles) block.props.subStyles = {};
                const childStyleObj = block.props.subStyles[newChildPath] || {};
                const ds = window.getComputedStyle(child);
                if (!childStyleObj.color) childStyleObj.color = ds.color;
                if (!childStyleObj.fontSize) childStyleObj.fontSize = ds.fontSize;
                if (!childStyleObj.fontWeight) childStyleObj.fontWeight = ds.fontWeight;
                if (!childStyleObj.margin) childStyleObj.margin = ds.margin;
                if (!childStyleObj.padding) childStyleObj.padding = ds.padding;
                if (!childStyleObj.display) childStyleObj.display = ds.display;
                block.props.subStyles[newChildPath] = childStyleObj;
            });

            State.promoteTemplateChildren(blockId, '', children);
            return 'c' + path;
        }

        if (!path.includes('.t')) return path; // Already dynamic or repeater
        
        const parts = path.split('.');
        
        // Find the FIRST part that is a template index
        let tIdx = -1;
        for(let i=0; i<parts.length; i++) {
            if (parts[i].startsWith('t')) { tIdx = i; break; }
        }
        if (tIdx === -1) return path;

        const parentPath = parts.slice(0, tIdx).join('.');
        const blockEl = document.getElementById('block_' + blockId);
        if (!blockEl) return path;

        // Find the actual DOM element for the parent
        const parentEl = parentPath === '' 
            ? blockEl.querySelector('.block-content').firstElementChild 
            : blockEl.querySelector(`[data-sf-path="${parentPath}"]`);
        
        if (!parentEl) return path;

        // Extract all children from DOM to materialize them in state
        const children = Array.from(parentEl.children).map(child => {
            const tagName = child.tagName.toLowerCase();
            return {
                type: tagName,
                promoted: true,
                props: {
                    html: child.innerHTML,
                    src: child.src || '',
                    href: child.href || '',
                    text: child.innerText
                }
            };
        });

        // 2. Pre-fill subStyles so they retain their layout visually!
        Array.from(parentEl.children).forEach((child, idx) => {
            const newChildPath = parentPath ? `${parentPath}.c${idx}` : `c${idx}`;
            if (!block.props.subStyles) block.props.subStyles = {};
            const childStyleObj = block.props.subStyles[newChildPath] || {};
            
            // Extract core styles from the DOM to persist in state so it doesn't lose original template style
            const ds = window.getComputedStyle(child);
            if (!childStyleObj.color) childStyleObj.color = ds.color;
            if (!childStyleObj.fontSize) childStyleObj.fontSize = ds.fontSize;
            if (!childStyleObj.fontWeight) childStyleObj.fontWeight = ds.fontWeight;
            if (!childStyleObj.margin) childStyleObj.margin = ds.margin;
            if (!childStyleObj.padding) childStyleObj.padding = ds.padding;
            if (!childStyleObj.display) childStyleObj.display = ds.display;
            
            block.props.subStyles[newChildPath] = childStyleObj;
        });

        State.promoteTemplateChildren(blockId, parentPath, children);
        
        // Construct the new path: the first .tX becomes .cX
        const newParts = [...parts];
        newParts[tIdx] = 'c' + newParts[tIdx].substring(1);
        return newParts.join('.');
    }

    return { init, renderAll, initContextMenu };
})();
