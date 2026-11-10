/**
 * Gamepad navigation & touch support for Steam Deck / Steam Big Picture / Controller mode.
 */

let running = false
let animFrameId = null
const prevBtnState = new Map() // padIndex -> boolean[]
let lastNavTime = 0
const NAV_DELAY_INITIAL = 280
const NAV_DELAY_REPEAT = 140
let navDirection = null
let navStartTime = 0

function getFocusableElements() {
  const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'
  const elements = Array.from(document.querySelectorAll(selector))
  return elements.filter((el) => {
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
}

function findPrimaryAction() {
  // 1. HomeView PLAY/INSTALL button
  const mainBtn = document.querySelector('.main:not(:disabled)')
  if (mainBtn) return mainBtn

  // 2. Login submit button
  const loginBtn = document.querySelector('.login__btn:not(:disabled)')
  if (loginBtn) return loginBtn

  // 3. Any active modal confirmation button
  const primaryModalBtn = document.querySelector('.dialog .btn--gold:not(:disabled), .dialog .btn--primary:not(:disabled)')
  if (primaryModalBtn) return primaryModalBtn

  return null
}

function findSettingsButton() {
  const buttons = Array.from(document.querySelectorAll('button'))
  return buttons.find((b) => /settings|configurações/i.test(b.textContent || '') || b.querySelector('svg[name="gear"]'))
}

function findCloseOrCancelButton() {
  const closeBtn = document.querySelector('.dialog__close, .dialog .btn--ghost, .bar__actions .btn--danger')
  return closeBtn
}

function moveFocus(dir) {
  const focusables = getFocusableElements()
  if (!focusables.length) return

  const current = document.activeElement
  const curIdx = focusables.indexOf(current)

  if (curIdx === -1 || current === document.body) {
    const primary = findPrimaryAction()
    if (primary && focusables.includes(primary)) {
      primary.focus()
      primary.classList.add('gamepad-focused')
      return
    }
    focusables[0].focus()
    focusables[0].classList.add('gamepad-focused')
    return
  }

  current.classList.remove('gamepad-focused')

  const curRect = current.getBoundingClientRect()
  const curCenter = { x: curRect.left + curRect.width / 2, y: curRect.top + curRect.height / 2 }

  let best = null
  let bestDist = Infinity

  for (const el of focusables) {
    if (el === current) continue
    const r = el.getBoundingClientRect()
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    const dx = center.x - curCenter.x
    const dy = center.y - curCenter.y

    let isMatch = false
    if (dir === 'up' && dy < -4) isMatch = true
    if (dir === 'down' && dy > 4) isMatch = true
    if (dir === 'left' && dx < -4) isMatch = true
    if (dir === 'right' && dx > 4) isMatch = true

    if (isMatch) {
      let dist
      if (dir === 'up' || dir === 'down') {
        dist = Math.abs(dy) + Math.abs(dx) * 2.2
      } else {
        dist = Math.abs(dx) + Math.abs(dy) * 2.2
      }
      if (dist < bestDist) {
        bestDist = dist
        best = el
      }
    }
  }

  const target = best || (
    (dir === 'down' || dir === 'right')
      ? focusables[(curIdx + 1) % focusables.length]
      : focusables[(curIdx - 1 + focusables.length) % focusables.length]
  )

  if (target) {
    target.focus()
    target.classList.add('gamepad-focused')
    try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch {}
  }
}

function handleGamepadAction(action) {
  switch (action) {
    case 'confirm': {
      const active = document.activeElement
      if (active && active !== document.body && typeof active.click === 'function') {
        active.click()
        return
      }
      const primary = findPrimaryAction()
      if (primary) primary.click()
      break
    }
    case 'play': {
      const primary = findPrimaryAction()
      if (primary) primary.click()
      break
    }
    case 'back': {
      const closeBtn = findCloseOrCancelButton()
      if (closeBtn) {
        closeBtn.click()
        return
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      break
    }
    case 'settings': {
      const settingsBtn = findSettingsButton()
      if (settingsBtn) settingsBtn.click()
      break
    }
  }
}

function pollGamepads() {
  if (!running) return
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
  const now = performance.now()

  for (let i = 0; i < gamepads.length; i++) {
    const gp = gamepads[i]
    if (!gp || !gp.connected) continue

    if (!prevBtnState.has(i)) {
      prevBtnState.set(i, new Array(gp.buttons.length).fill(false))
    }
    const prev = prevBtnState.get(i)

    const isBtnDown = (idx) => gp.buttons[idx]?.pressed || (gp.buttons[idx]?.value || 0) > 0.5
    const wasBtnPressed = (idx) => isBtnDown(idx) && !prev[idx]

    // Button 0: A (Confirm / Click)
    if (wasBtnPressed(0)) handleGamepadAction('confirm')

    // Button 1: B (Back / Cancel)
    if (wasBtnPressed(1)) handleGamepadAction('back')

    // Button 2: X (Direct Play / Submit)
    if (wasBtnPressed(2)) handleGamepadAction('play')

    // Button 3: Y (Settings)
    if (wasBtnPressed(3)) handleGamepadAction('settings')

    // Button 9: Start / Menu (Play / Submit)
    if (wasBtnPressed(9)) handleGamepadAction('play')

    // Navigation (D-Pad + Left Stick)
    const dpadUp = isBtnDown(12)
    const dpadDown = isBtnDown(13)
    const dpadLeft = isBtnDown(14)
    const dpadRight = isBtnDown(15)

    const stickX = gp.axes[0] || 0
    const stickY = gp.axes[1] || 0
    const THRESHOLD = 0.55

    let activeDir = null
    if (dpadUp || stickY < -THRESHOLD) activeDir = 'up'
    else if (dpadDown || stickY > THRESHOLD) activeDir = 'down'
    else if (dpadLeft || stickX < -THRESHOLD) activeDir = 'left'
    else if (dpadRight || stickX > THRESHOLD) activeDir = 'right'

    if (activeDir) {
      if (activeDir !== navDirection) {
        navDirection = activeDir
        navStartTime = now
        lastNavTime = now
        moveFocus(activeDir)
      } else {
        const timeHeld = now - navStartTime
        const timeSinceLast = now - lastNavTime
        if (timeHeld > NAV_DELAY_INITIAL && timeSinceLast > NAV_DELAY_REPEAT) {
          lastNavTime = now
          moveFocus(activeDir)
        }
      }
    } else if (navDirection) {
      navDirection = null
    }

    // Save previous button state
    for (let b = 0; b < gp.buttons.length; b++) {
      prev[b] = isBtnDown(b)
    }
  }

  animFrameId = requestAnimationFrame(pollGamepads)
}

export function startGamepadNavigation() {
  if (running) return
  running = true
  animFrameId = requestAnimationFrame(pollGamepads)

  window.addEventListener('pointerdown', () => {
    const focused = document.querySelector('.gamepad-focused')
    if (focused) focused.classList.remove('gamepad-focused')
  }, { passive: true })
}

export function stopGamepadNavigation() {
  running = false
  if (animFrameId) {
    cancelAnimationFrame(animFrameId)
    animFrameId = null
  }
}
