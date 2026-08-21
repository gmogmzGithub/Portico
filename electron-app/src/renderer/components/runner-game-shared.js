(function attachRunnerGameShared(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.RunnerGameShared = factory();
})(typeof globalThis !== 'undefined' ? globalThis : window, function createRunnerGameShared() {
  const GAME_SPEED_BASE = 2.5;
  const GAME_SPEED_MAX = 6;
  const GAME_SPEED_ACCEL = 0.0003;
  const GAME_SPEED_MULTIPLIER = 1.8;

  function readLocalStorageNumber(storageKey, fallbackValue = 0) {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = parseInt(raw || `${fallbackValue}`, 10);
      return Number.isFinite(parsed) ? parsed : fallbackValue;
    } catch (_error) {
      return fallbackValue;
    }
  }

  function writeLocalStorageNumber(storageKey, value) {
    try {
      localStorage.setItem(storageKey, `${value}`);
    } catch (_error) {
      // Ignore storage write failures.
    }
  }

  function noop() {}

  function createRunnerGame(options = {}) {
    const {
      storageKey = 'runner-game-high-score',
      canvasId,
      scoreId,
      highScoreId,
      startOverlayId,
      gameOverOverlayId,
      startButtonId,
      restartButtonId,
      isActive = () => true,
      getColors = () => ({
        background: '#111827',
        ground: 'rgba(4, 98, 249, 0.5)',
        runner: '#0462f9',
        runnerEye: '#dbeafe',
        obstacle: '#f59e0b',
      }),
      onStart = noop,
      onGameOver = noop,
      onStateChange = noop,
    } = options;

    const state = {
      initialized: false,
      running: false,
      gameOver: false,
      hasStarted: false,
      resizeCanvas: null,
      animationId: null,
      lastTime: 0,
      score: 0,
      highScore: 0,
      speed: GAME_SPEED_BASE,
      spawnTimer: 0,
      nextSpawn: 900,
      obstacles: [],
      runner: null,
      canvas: null,
      ctx: null,
      overlays: {},
      scoreEl: null,
      highScoreEl: null,
      cleanupFns: [],
    };

    function snapshot() {
      return {
        initialized: state.initialized,
        running: state.running,
        gameOver: state.gameOver,
        hasStarted: state.hasStarted,
        score: state.score,
        highScore: state.highScore,
      };
    }

    function publishState() {
      onStateChange(snapshot());
    }

    function resetGame() {
      state.running = false;
      state.gameOver = false;
      state.score = 0;
      state.speed = GAME_SPEED_BASE;
      state.spawnTimer = 0;
      state.nextSpawn = 900;
      state.obstacles = [];
      state.runner = {
        x: 40,
        y: 0,
        width: 26,
        height: 32,
        velocityY: 0,
        onGround: true,
      };
      if (state.scoreEl) state.scoreEl.textContent = '0';
      if (state.overlays.start) state.overlays.start.classList.remove('hidden');
      if (state.overlays.gameOver) state.overlays.gameOver.classList.add('hidden');
      publishState();
    }

    function updateScore(value) {
      const scoreValue = Math.max(0, Math.floor(value));
      if (state.scoreEl) state.scoreEl.textContent = `${scoreValue}`;
      if (scoreValue > state.highScore) {
        state.highScore = scoreValue;
        if (state.highScoreEl) state.highScoreEl.textContent = `${scoreValue}`;
        writeLocalStorageNumber(storageKey, scoreValue);
      }
      publishState();
    }

    function spawnObstacle(groundY, width) {
      const height = 18 + Math.random() * 26;
      const obstacleWidth = 16 + Math.random() * 18;
      state.obstacles.push({
        x: width + obstacleWidth,
        y: groundY - height,
        width: obstacleWidth,
        height,
      });
      state.nextSpawn = 700 + Math.random() * 900;
    }

    function draw(canvasWidth, canvasHeight, groundY) {
      const colors = getColors();
      const ctx = state.ctx;
      if (!ctx) return;

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      ctx.strokeStyle = colors.ground;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY + 0.5);
      ctx.lineTo(canvasWidth, groundY + 0.5);
      ctx.stroke();

      const runner = state.runner;
      ctx.fillStyle = colors.runner;
      ctx.fillRect(runner.x, runner.y, runner.width, runner.height);
      ctx.fillStyle = colors.runnerEye;
      ctx.fillRect(runner.x + runner.width - 6, runner.y + 6, 4, 4);

      ctx.fillStyle = colors.obstacle;
      state.obstacles.forEach((obstacle) => {
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
      });
    }

    function endGame() {
      state.running = false;
      state.gameOver = true;
      if (state.overlays.gameOver) state.overlays.gameOver.classList.remove('hidden');
      publishState();
      onGameOver(snapshot());
    }

    function tick(timestamp) {
      if (!state.running) return;
      if (!isActive()) {
        pause(false);
        return;
      }

      state.resizeCanvas();
      const canvasWidth = state.canvas.clientWidth;
      const canvasHeight = state.canvas.clientHeight;
      const groundY = canvasHeight - 28;
      const deltaMs = Math.min(32, timestamp - state.lastTime);
      const delta = deltaMs / 16.67;
      state.lastTime = timestamp;

      const runner = state.runner;
      runner.velocityY += 0.7 * delta;
      runner.y += runner.velocityY * delta;

      if (runner.y + runner.height >= groundY) {
        runner.y = groundY - runner.height;
        runner.velocityY = 0;
        runner.onGround = true;
      } else {
        runner.onGround = false;
      }

      state.spawnTimer += deltaMs;
      if (state.spawnTimer >= state.nextSpawn) {
        spawnObstacle(groundY, canvasWidth);
        state.spawnTimer = 0;
      }

      state.speed = Math.min(GAME_SPEED_MAX, state.speed + GAME_SPEED_ACCEL * deltaMs);
      state.obstacles = state.obstacles
        .map((obstacle) => ({
          ...obstacle,
          x: obstacle.x - state.speed * GAME_SPEED_MULTIPLIER * delta,
        }))
        .filter((obstacle) => obstacle.x + obstacle.width > -10);

      for (const obstacle of state.obstacles) {
        const hit =
          runner.x < obstacle.x + obstacle.width &&
          runner.x + runner.width > obstacle.x &&
          runner.y < obstacle.y + obstacle.height &&
          runner.y + runner.height > obstacle.y;
        if (hit) {
          endGame();
          draw(canvasWidth, canvasHeight, groundY);
          return;
        }
      }

      state.score += deltaMs * 0.03;
      updateScore(state.score);
      draw(canvasWidth, canvasHeight, groundY);
      state.animationId = requestAnimationFrame(tick);
    }

    function startGame() {
      if (state.running || !state.initialized) return;
      state.resizeCanvas();
      state.hasStarted = true;
      state.running = true;
      state.gameOver = false;
      state.score = 0;
      state.speed = GAME_SPEED_BASE;
      state.spawnTimer = 0;
      state.obstacles = [];
      state.runner.velocityY = 0;
      state.runner.onGround = true;
      if (state.overlays.start) state.overlays.start.classList.add('hidden');
      if (state.overlays.gameOver) state.overlays.gameOver.classList.add('hidden');
      state.lastTime = performance.now();
      publishState();
      onStart(snapshot());
      state.animationId = requestAnimationFrame(tick);
    }

    function jumpOrStart() {
      if (!isActive()) return;
      if (!state.running) {
        if (state.gameOver) {
          resetGame();
        }
        startGame();
        return;
      }
      if (state.runner.onGround) {
        state.runner.velocityY = -12;
        state.runner.onGround = false;
      }
    }

    function pause(showStartOverlay = true) {
      if (!state.initialized) return;
      state.running = false;
      if (state.animationId) {
        cancelAnimationFrame(state.animationId);
        state.animationId = null;
      }
      if (showStartOverlay && state.overlays.start && !state.gameOver) {
        state.overlays.start.classList.remove('hidden');
      }
      publishState();
    }

    function destroy() {
      pause(false);
      state.cleanupFns.forEach((cleanup) => cleanup());
      state.cleanupFns = [];
      state.initialized = false;
      publishState();
    }

    function init() {
      if (state.initialized) {
        state.resizeCanvas();
        publishState();
        return api;
      }

      const canvas = document.getElementById(canvasId);
      if (!canvas) {
        return api;
      }

      const ctx = canvas.getContext('2d');
      const scoreEl = document.getElementById(scoreId);
      const highScoreEl = document.getElementById(highScoreId);
      const startOverlay = document.getElementById(startOverlayId);
      const gameOverOverlay = document.getElementById(gameOverOverlayId);
      const startBtn = document.getElementById(startButtonId);
      const restartBtn = document.getElementById(restartButtonId);

      const storedHighScore = readLocalStorageNumber(storageKey, 0);
      const resizeCanvas = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const targetWidth = Math.max(1, Math.floor(rect.width * dpr));
        const targetHeight = Math.max(1, Math.floor(rect.height * dpr));

        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      };

      state.initialized = true;
      state.canvas = canvas;
      state.ctx = ctx;
      state.scoreEl = scoreEl;
      state.highScoreEl = highScoreEl;
      state.overlays = { start: startOverlay, gameOver: gameOverOverlay };
      state.resizeCanvas = resizeCanvas;
      state.highScore = storedHighScore;
      if (highScoreEl) highScoreEl.textContent = `${storedHighScore}`;

      const onPointerDown = () => jumpOrStart();
      const onKeyDown = (event) => {
        if (event.code !== 'Space' && event.code !== 'ArrowUp') return;
        if (!isActive()) return;
        if (state.gameOver) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        jumpOrStart();
      };
      const onResize = () => resizeCanvas();

      canvas.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onResize);
      if (startBtn) startBtn.addEventListener('click', onPointerDown);
      if (restartBtn) restartBtn.addEventListener('click', onPointerDown);

      state.cleanupFns.push(() => canvas.removeEventListener('pointerdown', onPointerDown));
      state.cleanupFns.push(() => document.removeEventListener('keydown', onKeyDown));
      state.cleanupFns.push(() => window.removeEventListener('resize', onResize));
      if (startBtn) state.cleanupFns.push(() => startBtn.removeEventListener('click', onPointerDown));
      if (restartBtn) state.cleanupFns.push(() => restartBtn.removeEventListener('click', onPointerDown));

      resizeCanvas();
      resetGame();
      publishState();
      return api;
    }

    const api = {
      init,
      pause,
      destroy,
      getState: snapshot,
      start: startGame,
    };

    return api;
  }

  return {
    createRunnerGame,
  };
});
