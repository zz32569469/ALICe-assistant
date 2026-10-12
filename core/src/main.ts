import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { loadOrCreateToken } from "./auth/token.js";
import { ChannelService } from "./channels/channelService.js";
import { ChannelStore } from "./channels/channelStore.js";
import { WorkerRunner } from "./channels/workerRunner.js";
import { DEFAULT_TEST_COMMANDS, loadConfig } from "./config.js";
import { ClaudeWriterRunner } from "./plans/claudeWriterRunner.js";
import { gitStatusPaths, PlanService } from "./plans/planService.js";
import { PlanStore } from "./plans/planStore.js";
import { GameService } from "./games/gameService.js";
import { StageGuide } from "./games/stageGuide.js";
import { loadWorkflow, useWorkflow } from "./games/workflow.js";
import { MeetingStore } from "./games/meetings.js";
import { GameConfirmationStore } from "./games/gameConfirmations.js";
import { showDesktopToast } from "./notify/desktopToast.js";
import { FortuneService } from "./fortune/fortuneService.js";
import { uploadsDir } from "./uploads/uploadStore.js";
import { MemoryKeeper } from "./memory/memoryKeeper.js";
import { claudeInterpreter } from "./fortune/fortuneService.js";
import { GameStore } from "./games/gameStore.js";
import { NotificationService, NotificationStore } from "./notify/notificationService.js";
import { OutboxService } from "./relay/outboxService.js";
import { OutboxStore } from "./relay/outboxStore.js";
import type { Task } from "./tasks/taskStore.js";
import { ConversationService } from "./conversation/conversationService.js";
import { TranslateService } from "./translate/translateService.js";
import { loadLocalConfig } from "./localConfig.js";
import { EventHub } from "./protocol/eventHub.js";
import { ErrorLogger } from "./reliability/errorLog.js";
import { checkClaudeCodeAuth } from "./reasoning/claudeCodeAuth.js";
import { ClaudeCodeProvider } from "./reasoning/claudeCodeProvider.js";
import { ProxyMode } from "./conversation/proxyMode.js";
import { CodexBoard } from "./codex/codexBoard.js";
import { AliceHttpServer } from "./server/httpServer.js";
import { CharacterState } from "./state/characterState.js";
import { MessageStore } from "./store/messageStore.js";
import { checkCodexAuth } from "./tasks/codexAuth.js";
import { CodexRunner, killProcessTree } from "./tasks/codexRunner.js";
import { UnavailableRunner } from "./tasks/taskRunner.js";
import type { TaskRunner } from "./tasks/taskRunner.js";
import { TaskService } from "./tasks/taskService.js";
import { TaskStore } from "./tasks/taskStore.js";
import { QuotaService } from "./usage/quota.js";
import { UsageStore } from "./usage/usageStore.js";

async function main(): Promise<void> {
  const loadedConfig = loadConfig(process.env.ALICE_CONFIG);
  const local = loadLocalConfig(process.env.ALICE_LOCAL);
  // 專案卡的流程：本機有設定就用團隊流程，否則用內建的通用流程。
  const loadedWorkflow = loadWorkflow(local.workflowFile);
  useWorkflow(loadedWorkflow.workflow);
  const setupWarnings = local.reasons.map((reason) => `本機設定：${reason}（照 docs/本機設定.md 修正，或執行 node scripts/doctor.cjs）`);
  if (loadedWorkflow.warning !== undefined) setupWarnings.push(`本機設定：${loadedWorkflow.warning}`);
  // K7：Codex 是可選工具。use=false 或偵測不到時，寫程式改由 Claude 寫檔 worker 執行。
  let codexAvailable = false;
  if (loadedConfig.tools.codex.use !== false) {
    try {
      await checkCodexAuth(loadedConfig);
      codexAvailable = true;
      console.log("Codex ChatGPT 訂閱登入已確認。");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Codex 不可用，寫程式改由 Claude 執行：${reason}`);
      if (local.codexAvailable) setupWarnings.push(`本機設定寫 Codex 可用，但檢查失敗，寫程式改由 Claude 執行：${reason}`);
    }
  } else {
    console.log("Codex 已關閉（tools.codex.use = false），寫程式由 Claude 執行。");
  }
  const config = {
    ...loadedConfig,
    allowedOrigins: [...loadedConfig.allowedOrigins, ...local.remoteOrigins],
    tools: { codex: { ...loadedConfig.tools.codex, available: codexAvailable } },
  };
  const testCommandsFor = (task: Task): string[] =>
    config.tools.codex.repos[task.repo]?.testCommands
      ?? local.projects.find((project) => project.name === task.repo)?.testCommands
      ?? DEFAULT_TEST_COMMANDS;
  const claudeRunner = new ClaudeWriterRunner(config, { testCommandsFor });
  const codexRunner = codexAvailable ? new CodexRunner(config) : undefined;
  const runner: TaskRunner = !config.tools.codex.enabled
    ? new UnavailableRunner()
    : codexRunner ?? claudeRunner;
  const auth = await checkClaudeCodeAuth(config);
  console.log(`Claude Code 訂閱登入已確認（${auth.subscriptionType ?? "類型未知"}）。`);

  mkdirSync(config.dataDir, { recursive: true });
  const token = loadOrCreateToken(config.tokenPath);
  const databasePath = resolve(config.dataDir, "alice.db");
  // §83：截圖資料夾（ALICe 的 Read 工具要能讀，先建好）。
  mkdirSync(uploadsDir(config.dataDir), { recursive: true });
  const store = new MessageStore(databasePath);
  const taskStore = new TaskStore(databasePath);
  const channelStore = new ChannelStore(databasePath);
  const planStore = new PlanStore(databasePath);
  const outboxStore = new OutboxStore(databasePath);
  const usageStore = new UsageStore(databasePath);
  const gameStore = new GameStore(databasePath);
  const notificationStore = new NotificationStore(databasePath);
  const errors = new ErrorLogger(config.dataDir);
  const quotas = new QuotaService({ claudePath: config.claudePath });
  const state = new CharacterState({ now: () => new Date(), config });
  const provider = new ClaudeCodeProvider(config);
  const events = new EventHub();
  // §27：可派工、傳訊的同事 session 來自本機設定的 projects[].session。
  const outbox = new OutboxService({
    store: outboxStore,
    messages: store,
    events,
    relaySession: config.relaySession,
    targets: () => local.projects
      .filter((project) => project.session !== undefined)
      .map((project) => ({ project: project.name, role: project.role, session: project.session! })),
  });
  const worker = local.workersEnabled && local.knowledgeBase !== null
    ? new WorkerRunner(config, local.knowledgeBase, local.workerTimeoutMin)
    : undefined;
  const channels = new ChannelService({
    local,
    channels: channelStore,
    messages: store,
    runner: worker,
    events,
    usage: usageStore,
    errors,
  });
  const tasks = new TaskService({
    config,
    tasks: taskStore,
    messages: store,
    state,
    runner,
    events,
    killOrphan: (pid) => killProcessTree(pid),
    repoStatus: gitStatusPaths,
    usage: usageStore,
    errors,
  });
  const plans = new PlanService({
    config,
    local,
    plans: planStore,
    tasks: taskStore,
    messages: store,
    channels: channelStore,
    events,
    state,
    ...(worker === undefined ? {} : { worker }),
    ...(codexRunner === undefined ? {} : { codexRunner }),
    claudeRunner,
    quotas,
    usage: usageStore,
    errors,
    outbox,
  });
  // §30：專案卡與手機推播。
  // §65：Codex 任務看板（本機 127.0.0.1:47777），快取給進度資料用。
  const codexBoard = new CodexBoard({ url: config.codexBoardUrl, script: config.codexBoardScript });
  const games = new GameService({ store: gameStore, projects: () => local.projects, events, codexJobs: () => codexBoard.cachedJobs(), guide: new StageGuide(local.knowledgeBase).lookup, meetings: new MeetingStore(databasePath),
    // §75：任務完成與換階段等主人確認，新增確認卡片時跳桌面通知。
    confirmations: new GameConfirmationStore(databasePath),
    onConfirmation: (confirmation) => {
      void showDesktopToast(`${confirmation.gameName}：進度等你確認`, confirmation.lines.join("\n"))
        .then((error) => { if (error !== null) console.warn(`桌面通知失敗：${error}`); });
    },
  });
  const notifications = new NotificationService({
    store: notificationStore,
    events,
    planGoal: (planId) => planStore.get(planId)?.goal,
    digestInput: () => ({
      games: games.cards().map((card) => ({ game: card, lastActivityAt: card.lastActivityAt })),
      waitingDecisions: plans.activeAll().filter((entry) => entry.plan.status === "paused" || entry.plan.status === "pending_approval").length,
    }),
  });
  const proxy = new ProxyMode({ path: resolve(config.dataDir, "proxy-mode.json"), events });
  // §85：長期記憶（每天 4 點後整理一次，寫進事實檔的「ALICe 記住的事」）。
  const memory = new MemoryKeeper({
    dbPath: databasePath, factsPath: config.factsPath, backupDir: resolve(config.dataDir, "memory-backups"), messages: store,
    interpret: claudeInterpreter(config.claudePath, resolve(config.dataDir, "claude-code", "memory")),
  });
  const conversation = new ConversationService({ config, store, state, provider, events, tasks, channels, plans, outbox, games, local, proxy, memory, usage: usageStore, errors });
  channels.setFollowupHandler((followup) => conversation.enqueueChannelFollowup(followup));
  tasks.setCompletionHandler((message, task) => conversation.enqueueTaskCompletion(message, task));
  plans.setNotificationHandler((message, kind, plan, items, files) => conversation.enqueuePlanNotification(message, kind, plan, items, files));
  await tasks.recover();
  channels.recover();
  await plans.recover();
  conversation.recoverUnanswered();
  // §48：Chrome 插件的選取翻譯（Claude Code 訂閱、Haiku）。
  const translate = new TranslateService({ claudePath: config.claudePath, workDir: resolve(config.dataDir, "claude-code", "translate"), glossary: local.translateGlossary });
  // §77：塔羅占卜（Claude Code 一次性呼叫）；§79 起不參考工作。
  const fortune = new FortuneService({
    dbPath: databasePath, events, personaPath: config.personaPath, claudePath: config.claudePath,
    workDir: resolve(config.dataDir, "claude-code", "fortune"),
  });
  const server = new AliceHttpServer({ config, token, store, state, conversation, events, tasks, channels, plans, outbox, games, notifications, translate, proxy, codexBoard, fortune, memory, usage: usageStore, quotas, setupWarnings });
  const unsubscribe = state.subscribe((nextState) => events.broadcast("state.changed", nextState));
  // §46：每天早上 9 點後第一次檢查時，請艾莉絲核對各專案的任務清單。
  const dailyReview = (): void => { if (games.reviewDue()) conversation.enqueueDailyReview(); };
  // §65：先更新 Codex 任務快取，每日核對的進度資料才有最新的委派任務。
  // §74：會議前 30、10 分鐘提醒：對話裡留系統訊息，Windows 跳桌面通知。
  const meetingReminders = (): void => {
    for (const reminder of games.meetingReminders()) {
      conversation.postNotice(`⏰ ${reminder.text}`);
      void showDesktopToast(`${reminder.minutes} 分鐘後開會`, `${reminder.meeting.start}${reminder.meeting.end === null ? "" : `～${reminder.meeting.end}`} ${reminder.meeting.game === "" ? "" : `${reminder.meeting.game}：`}${reminder.meeting.title}`)
        .then((error) => { if (error !== null) console.warn(`桌面通知失敗：${error}`); });
    }
  };
  const tickTimer = setInterval(() => {
    state.tick();
    notifications.tick();
    meetingReminders();
    void memory.tick().then((text) => { if (text !== undefined) conversation.postNotice(text); });
    void codexBoard.refreshCache().finally(dailyReview);
  }, 60_000);
  notifications.tick();
  meetingReminders();
  void codexBoard.refreshCache().finally(dailyReview);
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(tickTimer);
    unsubscribe();
    try {
      await server.close();
    } finally {
      tasks.close();
      plans.close();
      planStore.close();
      notifications.close();
      notificationStore.close();
      gameStore.close();
      outboxStore.close();
      taskStore.close();
      channelStore.close();
      usageStore.close();
      store.close();
    }
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  try {
    const port = await server.listen();
    console.log(`Alice Core listening on http://${config.host}:${port}`);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

await main().catch((error: unknown) => {
  console.error("Alice Core failed to start:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
