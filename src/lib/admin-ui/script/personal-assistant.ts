/**
 * Admin UI — personal assistant builder browser-runtime module.
 */

export const PERSONAL_ASSISTANT_SCRIPT = `    const assistantBuilderState = { step: 0 };
    const MAX_UPLOADED_PROJECT_PLAN_CHARS = 128 * 1024;
    const assistantBuilderSteps = [
      { title: 'Basics', description: 'Set your assistant defaults, personality, and delivery settings.' },
      { title: 'Items', description: 'Add projects, obligations, events, workout goals, and nutrition goals your assistant should coach you through.' },
      { title: 'Review', description: 'Preview the generated plan, managed agents, and recurring workflows before applying.' }
    ];

    function assistantSlugify(value, fallback) {
      const normalized = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || fallback;
    }

    function defaultAssistantAgentId(assistantName) {
      return assistantSlugify(assistantName || 'personal-assistant', 'personal-assistant');
    }

    function defaultAssistantThreadId(assistantName, userId) {
      return defaultAssistantAgentId(assistantName) + '-' + (userId || 'me');
    }

    function defaultAssistantPlanFilePath(notesRepoPath, assistantName) {
      const base = String(notesRepoPath || '/srv/notes').replace(/\\/+$/, '') || '/srv/notes';
      return base + '/projects/' + defaultAssistantAgentId(assistantName) + '-plan.md';
    }

    function inferDefaultGitHubOwner() {
      const apps = Array.isArray(state.config && state.config.apps) ? state.config.apps : [];
      for (let i = 0; i < apps.length; i += 1) {
        const repoUrl = String(apps[i] && apps[i].repoUrl || '');
        const match = repoUrl.match(/github\\.com[:/]([^/]+)\//i);
        if (match && match[1]) {
          return match[1];
        }
      }
      return 'me';
    }

    function applyAssistantProfileDefaults(profile) {
      const chatProfile = state.config?.serviceProfiles?.gatewayChatPlatform;
      const environment = Array.isArray(chatProfile?.environment) ? chatProfile.environment : [];
      const defaultUserId = getEnvironmentValue(environment, 'CHAT_DEFAULT_USER_ID', 'me');
      const defaultChannelId = getEnvironmentValue(environment, 'CHAT_DEFAULT_CHANNEL_ID', 'coach');
      if (!profile.ownerName) profile.ownerName = 'Jim';
      if (!profile.githubOwner) profile.githubOwner = inferDefaultGitHubOwner();
      if (!profile.assistantName) profile.assistantName = 'Personal Assistant';
      if (!profile.personality) {
        profile.personality = 'You are a life coach who motivates me to succeed with clear, practical, high-accountability guidance.';
      }
      if (!profile.timezone) profile.timezone = 'America/New_York';
      if (!profile.notesRepoPath) profile.notesRepoPath = '/srv/notes';
      if (!Array.isArray(profile.notesSearchDirs)) profile.notesSearchDirs = [];
      if (!profile.recentNotesLimit) profile.recentNotesLimit = 10;
      if (!profile.chatUserId) profile.chatUserId = defaultUserId;
      if (!profile.chatChannelId) profile.chatChannelId = defaultChannelId;
      if (!profile.chatThreadTitle) profile.chatThreadTitle = profile.assistantName;
      if (!profile.chatThreadId) profile.chatThreadId = defaultAssistantThreadId(profile.assistantName, profile.chatUserId);
      if (!profile.localAgentId) profile.localAgentId = defaultAssistantAgentId(profile.assistantName);
      if (!profile.planFilePath) profile.planFilePath = defaultAssistantPlanFilePath(profile.notesRepoPath, profile.assistantName);
      if (!profile.localProviderName) profile.localProviderName = firstAvailableProviderName() || 'local-llm';
      if (!profile.localModel) profile.localModel = firstAvailableModelId(profile.localProviderName) || 'qwen/qwen3-32b';
      if (!profile.localBaseUrl) profile.localBaseUrl = 'http://127.0.0.1:5301';
      if (!profile.expertAgentId) profile.expertAgentId = 'expert-planner';
      if (!profile.expertProviderName) profile.expertProviderName = 'openai-main';
      if (!profile.expertModel) profile.expertModel = 'gpt-5.4';
      if (!profile.expertBaseUrl) profile.expertBaseUrl = 'https://api.openai.com/v1';
      if (!profile.expertApiKey) profile.expertApiKey = '__SET_OPENAI_API_KEY__';
      if (!profile.focusStrategy) {
        profile.focusStrategy = 'Prioritize the few items that move important projects and personal commitments forward without overloading the day.';
      }
      if (!profile.weeklyOutcome) {
        profile.weeklyOutcome = 'End each week with the highest-leverage work advanced, obligations covered, and the next week already staged.';
      }
      const collections = [profile.projects, profile.obligations, profile.fitnessGoals, profile.nutritionGoals, profile.events];
      collections.forEach(function(items) {
        if (!Array.isArray(items)) {
          return;
        }
        items.forEach(function(item) {
          if (!item || typeof item !== 'object') {
            return;
          }
          if (item.priority === 'critical') item.priority = 'urgent';
          if (item.priority === 'medium') item.priority = 'med';
        });
      });
    }

    function ensurePersonalAssistantConfig() {
      if (!state.config.personalAssistant) {
        state.config.personalAssistant = {
          enabled: false,
          ownerName: 'Jim',
          githubOwner: inferDefaultGitHubOwner(),
          assistantName: 'Personal Assistant',
          personality: 'You are a life coach who motivates me to succeed with clear, practical, high-accountability guidance.',
          timezone: 'America/New_York',
          notesRepoPath: '/srv/notes',
          planFilePath: '/srv/notes/projects/personal-assistant-plan.md',
          notesSearchDirs: [],
          recentNotesLimit: 10,
          chatUserId: 'me',
          chatChannelId: 'coach',
          chatThreadId: 'personal-assistant-me',
          chatThreadTitle: 'Personal Assistant',
          localAgentId: 'personal-assistant',
          localProviderName: 'local-llm',
          localModel: 'qwen/qwen3-32b',
          localBaseUrl: 'http://127.0.0.1:5301',
          expertAgentId: 'expert-planner',
          expertProviderName: 'openai-main',
          expertModel: 'gpt-5.4',
          expertBaseUrl: 'https://api.openai.com/v1',
          expertApiKey: '__SET_OPENAI_API_KEY__',
          focusStrategy: 'Prioritize the few items that move important projects and personal commitments forward without overloading the day.',
          weeklyOutcome: 'End each week with the highest-leverage work advanced, obligations covered, and the next week already staged.',
          priorities: [],
          weeklyThemes: [],
          projects: [],
          obligations: [],
          fitnessGoals: [],
          nutritionGoals: [],
          events: [],
          schedules: {
            morningCheckInCron: '0 8 * * *',
            middayCheckInCron: '30 12 * * *',
            eveningCheckInCron: '30 18 * * *',
            weeklyPlanningCron: '0 7 * * 1',
            weeklyReviewCron: '0 18 * * 0'
          }
        };
      }
      applyAssistantProfileDefaults(state.config.personalAssistant);
      return state.config.personalAssistant;
    }

    function createAssistantProject() {
      const profile = ensurePersonalAssistantConfig();
      const index = profile.projects.length + 1;
      return {
        id: 'project-' + index,
        name: 'New Item ' + index,
        status: 'on-track',
        priority: 'high',
        summary: 'Define the actual outcome this project needs to reach.',
        nextAction: 'Write the next concrete step.',
        repoSlug: '',
        planFilePath: '',
        planContent: '',
        deadline: '',
        reminder: 'none',
        notes: ''
      };
    }

    function createAssistantObligation() {
      const profile = ensurePersonalAssistantConfig();
      const index = profile.obligations.length + 1;
      return {
        id: 'obligation-' + index,
        title: 'New Obligation ' + index,
        category: 'personal',
        status: 'active',
        priority: 'med',
        deadline: '',
        schedule: '',
        notes: ''
      };
    }

    function createAssistantGoal(prefix) {
      const profile = ensurePersonalAssistantConfig();
      const collection = prefix === 'fitnessGoals' ? profile.fitnessGoals : profile.nutritionGoals;
      const index = collection.length + 1;
      return {
        id: assistantSlugify(prefix, 'goal') + '-' + index,
        title: 'New Goal ' + index,
        target: 'Describe the target clearly.',
        cadence: '',
        status: 'active',
        priority: 'med',
        notes: ''
      };
    }

    function createAssistantEvent() {
      const profile = ensurePersonalAssistantConfig();
      const index = profile.events.length + 1;
      return {
        id: 'event-' + index,
        title: 'New Event ' + index,
        startDate: '',
        endDate: '',
        location: '',
        priority: 'med',
        notes: ''
      };
    }

    function assistantOptionList(options, currentValue) {
      return options.map(function(option) {
        const value = typeof option === 'string' ? option : option.value;
        const label = typeof option === 'string' ? option : option.label;
        return '<option value="' + escapeHtml(value) + '"' + (value === currentValue ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join('');
    }

    function assistantArrayText(values) {
      return escapeHtml((values || []).join('\\n'));
    }

    function assistantInput(label, field, value, options) {
      const extraClass = options && options.full ? ' full' : '';
      return '<label class="wizard-field' + extraClass + '">' +
        '<span class="wizard-label">' + escapeHtml(label) + '</span>' +
        '<input data-assistant-field="' + escapeHtml(field) + '" value="' + escapeHtml(value || '') + '" />' +
      '</label>';
    }

    function assistantTextarea(label, field, value, options) {
      const extraClass = options && options.full ? ' full' : '';
      const rows = options && options.rows ? options.rows : 4;
      const arrayField = options && options.arrayField ? ' data-assistant-array-field="' + escapeHtml(field) + '"' : ' data-assistant-field="' + escapeHtml(field) + '"';
      return '<label class="wizard-field' + extraClass + '">' +
        '<span class="wizard-label">' + escapeHtml(label) + '</span>' +
        '<textarea class="assistant-builder-textarea" rows="' + rows + '"' + arrayField + '>' + escapeHtml(value || '') + '</textarea>' +
      '</label>';
    }

    function assistantItemField(section, index, label, field, value, options) {
      const extraClass = options && options.full ? ' full' : '';
      return '<label class="wizard-field' + extraClass + '">' +
        '<span class="wizard-label">' + escapeHtml(label) + '</span>' +
        '<input data-assistant-section="' + escapeHtml(section) + '" data-assistant-index="' + String(index) + '" data-assistant-field="' + escapeHtml(field) + '" value="' + escapeHtml(value || '') + '" />' +
      '</label>';
    }

    function assistantItemTextarea(section, index, label, field, value, options) {
      const extraClass = options && options.full ? ' full' : '';
      const rows = options && options.rows ? options.rows : 3;
      return '<label class="wizard-field' + extraClass + '">' +
        '<span class="wizard-label">' + escapeHtml(label) + '</span>' +
        '<textarea class="assistant-builder-textarea" rows="' + rows + '" data-assistant-section="' + escapeHtml(section) + '" data-assistant-index="' + String(index) + '" data-assistant-field="' + escapeHtml(field) + '">' + escapeHtml(value || '') + '</textarea>' +
      '</label>';
    }

    function assistantItemSelect(section, index, label, field, value, options) {
      return '<label class="wizard-field">' +
        '<span class="wizard-label">' + escapeHtml(label) + '</span>' +
        '<select data-assistant-section="' + escapeHtml(section) + '" data-assistant-index="' + String(index) + '" data-assistant-field="' + escapeHtml(field) + '">' +
          assistantOptionList(options, value) +
        '</select>' +
      '</label>';
    }

    function assistantProjectPlanUpload(section, index) {
      return '<label class="wizard-field full">' +
        '<span class="wizard-label">Upload Project Plan (from your local machine)</span>' +
        '<input type="file" accept=".md,.markdown,.txt,.yaml,.yml,.json" data-assistant-upload="project-plan" data-assistant-section="' + escapeHtml(section) + '" data-assistant-index="' + String(index) + '" />' +
      '</label>';
    }

    function generatedAssistantWorkflowNames(profile) {
      const prefix = profile.localAgentId;
      return [
        prefix + '-morning',
        prefix + '-midday',
        prefix + '-evening',
        prefix + '-weekly-planning',
        prefix + '-weekly-review',
        prefix + '-log-progress'
      ];
    }

    function buildAssistantPlanPreview(profile) {
      function itemList(items, formatter) {
        if (!items || items.length === 0) {
          return '- none yet';
        }
        return items.map(formatter).join('\\n\\n');
      }

      return [
        '# ' + profile.assistantName + ' Operating Plan',
        '',
        'Owner: ' + profile.ownerName,
        'Time zone: ' + profile.timezone,
        '',
        '## Coaching Intent',
        profile.focusStrategy,
        '',
        '## Coach Personality',
        profile.personality,
        '',
        '## Weekly Outcome',
        profile.weeklyOutcome,
        '',
        '## Priority Stack',
        profile.priorities.length ? profile.priorities.map(function(item) { return '- ' + item; }).join('\\n') : '- none yet',
        '',
        '## Weekly Themes',
        profile.weeklyThemes.length ? profile.weeklyThemes.map(function(item) { return '- ' + item; }).join('\\n') : '- none yet',
        '',
        '## Active Projects',
        itemList(profile.projects, function(project) {
          const hasUploadedPlan = Boolean(project.planContent && String(project.planContent).trim());
          return [
            '- ' + project.name + ' [' + project.status + ', ' + project.priority + ']',
            '  Summary: ' + project.summary,
            '  Next: ' + project.nextAction,
            project.repoSlug ? '  Repo: ' + project.repoSlug : '',
            project.planFilePath ? '  Project plan: ' + project.planFilePath : '',
            hasUploadedPlan ? '  Project plan content: (uploaded inline)' : '',
            project.deadline ? '  Deadline: ' + project.deadline : '',
            project.reminder ? '  Reminder: ' + project.reminder : '',
            project.notes ? '  Notes: ' + project.notes : ''
          ].filter(Boolean).join('\\n');
        }),
        '',
        '## Obligations And Responsibilities',
        itemList(profile.obligations, function(item) {
          return [
            '- ' + item.title + ' [' + item.category + ', ' + item.status + ', ' + item.priority + ']',
            item.deadline ? '  Deadline: ' + item.deadline : '',
            item.schedule ? '  Schedule: ' + item.schedule : '',
            item.notes ? '  Notes: ' + item.notes : ''
          ].filter(Boolean).join('\\n');
        }),
        '',
        '## Workout Goals',
        itemList(profile.fitnessGoals, function(goal) {
          return [
            '- ' + goal.title + ' [' + goal.status + ', ' + goal.priority + ']',
            '  Target: ' + goal.target,
            goal.cadence ? '  Cadence: ' + goal.cadence : '',
            goal.notes ? '  Notes: ' + goal.notes : ''
          ].filter(Boolean).join('\\n');
        }),
        '',
        '## Nutrition Goals',
        itemList(profile.nutritionGoals, function(goal) {
          return [
            '- ' + goal.title + ' [' + goal.status + ', ' + goal.priority + ']',
            '  Target: ' + goal.target,
            goal.cadence ? '  Cadence: ' + goal.cadence : '',
            goal.notes ? '  Notes: ' + goal.notes : ''
          ].filter(Boolean).join('\\n');
        }),
        '',
        '## Trips, Events, And Important Dates',
        itemList(profile.events, function(item) {
          return [
            '- ' + item.title + ' [' + item.priority + ']',
            '  Starts: ' + (item.startDate || 'TBD'),
            item.endDate ? '  Ends: ' + item.endDate : '',
            item.location ? '  Location: ' + item.location : '',
            item.notes ? '  Notes: ' + item.notes : ''
          ].filter(Boolean).join('\\n');
        })
      ].join('\\n');
    }

    function renderAssistantProjectStep(profile) {
      const githubOwner = profile.githubOwner || 'me';
      const projectsHtml = '<div class="assistant-builder-review-card">' +
        '<h3>Projects</h3>' +
        '<p class="assistant-builder-note">Linked work the coach should track. Optional plan file path is read from disk on Apply and embedded into the master plan so the coach can see milestones, timelines, and goals.</p>' +
        '<div class="assistant-builder-list">' +
        (profile.projects.length === 0
          ? '<div class="assistant-builder-note">No projects yet.</div>'
          : profile.projects.map(function(project, index) {
              return '<div class="assistant-builder-item">' +
                '<div class="assistant-builder-item-header">' +
                  '<strong>' + escapeHtml(project.name || project.id) + '</strong>' +
                  '<button type="button" class="danger" data-assistant-action="remove-item" data-assistant-section="projects" data-assistant-index="' + String(index) + '">Remove</button>' +
                '</div>' +
                '<div class="assistant-builder-grid">' +
                  assistantItemField('projects', index, 'Item Id', 'id', project.id) +
                  assistantItemField('projects', index, 'Title', 'name', project.name) +
                  assistantItemSelect('projects', index, 'Priority', 'priority', project.priority, ['urgent', 'high', 'med', 'low']) +
                  assistantItemField('projects', index, 'Event Date (optional)', 'deadline', project.deadline || '') +
                  assistantItemSelect('projects', index, 'Reminder', 'reminder', project.reminder || 'none', [
                    { value: 'none', label: 'none' },
                    { value: 'at-time', label: 'at time' },
                    { value: '1-hour-before', label: '1 hour before' },
                    { value: '1-day-before', label: '1 day before' },
                    { value: '1-week-before', label: '1 week before' }
                  ]) +
                  assistantItemField('projects', index, 'Repo Slug (optional)', 'repoSlug', project.repoSlug || '') +
                  '<label class="wizard-field full"><span class="wizard-label">Repo Preview</span><small>' +
                    escapeHtml((project.repoSlug || '').trim() ? (githubOwner + '/' + project.repoSlug.trim().replace(/^\\/+|\\/+$/g, '')) : (githubOwner + '/<repo-slug>')) +
                  '</small></label>' +
                  assistantItemField('projects', index, 'Project Plan Path On Gateway (optional fallback)', 'planFilePath', project.planFilePath || '', { full: true }) +
                  assistantProjectPlanUpload('projects', index) +
                  '<label class="wizard-field full"><span class="wizard-label">Uploaded Plan Status</span><small>' +
                    escapeHtml(project.planContent && String(project.planContent).trim()
                      ? ('Attached (' + String(project.planContent.length) + ' chars)')
                      : 'No uploaded plan attached') +
                  '</small></label>' +
                  '<div class="toolbar"><button type="button" data-assistant-action="clear-project-plan" data-assistant-section="projects" data-assistant-index="' + String(index) + '">Clear Uploaded Plan</button></div>' +
                  assistantItemField('projects', index, 'Next Action', 'nextAction', project.nextAction) +
                  assistantItemTextarea('projects', index, 'Summary', 'summary', project.summary, { full: true, rows: 3 }) +
                  assistantItemTextarea('projects', index, 'Notes', 'notes', project.notes || '', { full: true, rows: 3 }) +
                '</div>' +
              '</div>';
            }).join('')) +
        '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="projects">Add Project</button></div>' +
        '</div>' +
      '</div>';

      const obligationsHtml = '<div class="assistant-builder-review-card">' +
        '<h3>Obligations</h3>' +
        '<p class="assistant-builder-note">Recurring responsibilities like coaching soccer, family commitments, bills, or deadlines.</p>' +
        '<div class="assistant-builder-list">' +
          (profile.obligations.length === 0
            ? '<div class="assistant-builder-note">No obligations yet.</div>'
            : profile.obligations.map(function(item, index) {
                return '<div class="assistant-builder-item">' +
                  '<div class="assistant-builder-item-header">' +
                    '<strong>' + escapeHtml(item.title || item.id) + '</strong>' +
                    '<button type="button" class="danger" data-assistant-action="remove-item" data-assistant-section="obligations" data-assistant-index="' + String(index) + '">Remove</button>' +
                  '</div>' +
                  '<div class="assistant-builder-grid">' +
                    assistantItemField('obligations', index, 'Obligation Id', 'id', item.id) +
                    assistantItemField('obligations', index, 'Title', 'title', item.title) +
                    assistantItemField('obligations', index, 'Category', 'category', item.category) +
                    assistantItemSelect('obligations', index, 'Status', 'status', item.status, ['active', 'upcoming', 'paused', 'done']) +
                    assistantItemSelect('obligations', index, 'Priority', 'priority', item.priority, ['urgent', 'high', 'med', 'low']) +
                    assistantItemField('obligations', index, 'Deadline', 'deadline', item.deadline || '') +
                    assistantItemField('obligations', index, 'Schedule', 'schedule', item.schedule || '') +
                    assistantItemTextarea('obligations', index, 'Notes', 'notes', item.notes || '', { full: true, rows: 3 }) +
                  '</div>' +
                '</div>';
              }).join('')) +
          '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="obligations">Add Obligation</button></div>' +
        '</div>' +
      '</div>';

      const eventsHtml = '<div class="assistant-builder-review-card">' +
        '<h3>Trips, Events, And Important Dates</h3>' +
        '<p class="assistant-builder-note">Travel, appointments, launches, games, or any date that should shape the week.</p>' +
        '<div class="assistant-builder-list">' +
          (profile.events.length === 0
            ? '<div class="assistant-builder-note">No events yet.</div>'
            : profile.events.map(function(item, index) {
                return '<div class="assistant-builder-item">' +
                  '<div class="assistant-builder-item-header">' +
                    '<strong>' + escapeHtml(item.title || item.id) + '</strong>' +
                    '<button type="button" class="danger" data-assistant-action="remove-item" data-assistant-section="events" data-assistant-index="' + String(index) + '">Remove</button>' +
                  '</div>' +
                  '<div class="assistant-builder-grid">' +
                    assistantItemField('events', index, 'Event Id', 'id', item.id) +
                    assistantItemField('events', index, 'Title', 'title', item.title) +
                    assistantItemField('events', index, 'Start', 'startDate', item.startDate || '') +
                    assistantItemField('events', index, 'End', 'endDate', item.endDate || '') +
                    assistantItemField('events', index, 'Location', 'location', item.location || '') +
                    assistantItemSelect('events', index, 'Priority', 'priority', item.priority, ['urgent', 'high', 'med', 'low']) +
                    assistantItemTextarea('events', index, 'Notes', 'notes', item.notes || '', { full: true, rows: 3 }) +
                  '</div>' +
                '</div>';
              }).join('')) +
          '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="events">Add Event</button></div>' +
        '</div>' +
      '</div>';

      return '<div class="assistant-builder-review">' +
        projectsHtml +
        obligationsHtml +
        eventsHtml +
        renderAssistantGoalCollection('fitnessGoals', 'Workout Goals', profile.fitnessGoals, 'Add workout goals, training blocks, recovery goals, or movement routines.') +
        renderAssistantGoalCollection('nutritionGoals', 'Nutrition Goals', profile.nutritionGoals, 'Add nutrition goals, meal structure, weight targets, or guardrails.') +
      '</div>';
    }

    function renderAssistantCommitmentStep(profile) {
      // Deprecated: obligations + events are now rendered inside renderAssistantProjectStep.
      return renderAssistantProjectStep(profile);
    }

    function renderAssistantGoalCollection(section, title, items, emptyMessage) {
      return '<div class="assistant-builder-review-card">' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        '<div class="assistant-builder-list">' +
          (items.length === 0
            ? '<div class="assistant-builder-note">' + escapeHtml(emptyMessage) + '</div>'
            : items.map(function(item, index) {
                return '<div class="assistant-builder-item">' +
                  '<div class="assistant-builder-item-header">' +
                    '<strong>' + escapeHtml(item.title || item.id) + '</strong>' +
                    '<button type="button" class="danger" data-assistant-action="remove-item" data-assistant-section="' + escapeHtml(section) + '" data-assistant-index="' + String(index) + '">Remove</button>' +
                  '</div>' +
                  '<div class="assistant-builder-grid">' +
                    assistantItemField(section, index, 'Goal Id', 'id', item.id) +
                    assistantItemField(section, index, 'Title', 'title', item.title) +
                    assistantItemField(section, index, 'Target', 'target', item.target) +
                    assistantItemField(section, index, 'Cadence', 'cadence', item.cadence || '') +
                    assistantItemSelect(section, index, 'Status', 'status', item.status, ['active', 'building', 'maintain', 'paused', 'done']) +
                    assistantItemSelect(section, index, 'Priority', 'priority', item.priority, ['urgent', 'high', 'med', 'low']) +
                    assistantItemTextarea(section, index, 'Notes', 'notes', item.notes || '', { full: true, rows: 3 }) +
                  '</div>' +
                '</div>';
              }).join('')) +
          '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="' + escapeHtml(section) + '">Add ' + escapeHtml(title.slice(0, -1)) + '</button></div>' +
        '</div>' +
      '</div>';
    }

    function renderAssistantHealthStep(profile) {
      return '<div class="assistant-builder-review">' +
        renderAssistantGoalCollection('fitnessGoals', 'Workout Goals', profile.fitnessGoals, 'Add workout goals, training blocks, recovery goals, or movement routines.') +
        renderAssistantGoalCollection('nutritionGoals', 'Nutrition Goals', profile.nutritionGoals, 'Add nutrition goals, meal structure, weight targets, or guardrails.') +
      '</div>';
    }

    function renderAssistantReviewStep(profile) {
      const generatedAgents = [profile.localAgentId, profile.expertAgentId];
      const generatedWorkflows = generatedAssistantWorkflowNames(profile);
      return '<div class="assistant-builder-review">' +
        '<div class="assistant-builder-review-card">' +
          '<h3>What Apply Will Update</h3>' +
          '<div class="assistant-builder-meta">' +
            '<div><strong>Plan file:</strong> ' + escapeHtml(profile.planFilePath) + '</div>' +
            '<div><strong>Notes repo:</strong> ' + escapeHtml(profile.notesRepoPath) + '</div>' +
            '<div><strong>GitHub default owner:</strong> ' + escapeHtml(profile.githubOwner || 'me') + '</div>' +
            '<div><strong>Chat thread:</strong> ' + escapeHtml(profile.chatChannelId + ' / ' + profile.chatThreadId) + '</div>' +
            '<div><strong>Managed agents:</strong> ' + escapeHtml(generatedAgents.join(', ')) + '</div>' +
            '<div><strong>Managed workflows:</strong> ' + escapeHtml(generatedWorkflows.join(', ')) + '</div>' +
            '<div><strong>Last applied:</strong> ' + escapeHtml(profile.lastAppliedAt || 'never') + '</div>' +
          '</div>' +
          '<p class="assistant-builder-note" style="margin-top:.75rem">You do not need to create this plan file yourself. Apply writes and refreshes it automatically. Notes search uses your notes repo broadly unless a custom directory filter is added in raw JSON.</p>' +
        '</div>' +
        '<div class="assistant-builder-review-card">' +
          '<h3>Generated Plan Preview</h3>' +
          '<pre>' + escapeHtml(buildAssistantPlanPreview(profile)) + '</pre>' +
        '</div>' +
      '</div>';
    }

    function renderAssistantBuilderStep() {
      if (!state.config) {
        return;
      }
      const profile = ensurePersonalAssistantConfig();
      const step = assistantBuilderSteps[assistantBuilderState.step];
      const body = document.getElementById('assistantBuilderBody');
      const label = document.getElementById('assistantBuilderStepLabel');
      const backButton = document.getElementById('assistantBuilderBackButton');
      const nextButton = document.getElementById('assistantBuilderNextButton');
      const applyButton = document.getElementById('assistantBuilderApplyButton');
      if (!body || !label || !backButton || !nextButton || !applyButton) {
        return;
      }

      label.textContent = step.title + ': ' + step.description;
      backButton.disabled = assistantBuilderState.step === 0;
      nextButton.hidden = assistantBuilderState.step === assistantBuilderSteps.length - 1;
      applyButton.hidden = assistantBuilderState.step !== assistantBuilderSteps.length - 1;

      if (assistantBuilderState.step === 0) {
        const defaultUserId = getEnvironmentValue(state.config.serviceProfiles.gatewayChatPlatform.environment || [], 'CHAT_DEFAULT_USER_ID', 'me');
        const defaultChannelId = getEnvironmentValue(state.config.serviceProfiles.gatewayChatPlatform.environment || [], 'CHAT_DEFAULT_CHANNEL_ID', 'coach');
        body.innerHTML = '<div class="assistant-builder-review">' +
          '<div class="assistant-builder-review-card">' +
            '<h3>Assistant Basics</h3>' +
            '<p class="assistant-builder-note">Set your assistant defaults once, then add items. Notes are searched from your notes repo broadly by default, so you do not need to manage folder filters here.</p>' +
            '<div class="assistant-builder-grid">' +
              '<label class="wizard-field"><span class="wizard-label">Enabled</span><select data-assistant-field="enabled">' + assistantOptionList([{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }], String(profile.enabled)) + '</select></label>' +
              assistantInput('Owner Name', 'ownerName', profile.ownerName) +
              assistantInput('GitHub User', 'githubOwner', profile.githubOwner || 'me') +
              assistantInput('Assistant Name', 'assistantName', profile.assistantName) +
              assistantInput('Time Zone', 'timezone', profile.timezone) +
              assistantTextarea('Assistant Personality', 'personality', profile.personality || '', { full: true, rows: 3 }) +
              assistantTextarea('Focus Strategy', 'focusStrategy', profile.focusStrategy, { full: true, rows: 4 }) +
              assistantTextarea('Weekly Outcome', 'weeklyOutcome', profile.weeklyOutcome, { full: true, rows: 4 }) +
            '</div>' +
            '<div class="assistant-builder-meta" style="margin-top:1rem">' +
              '<div><strong>Default notes repo:</strong> ' + escapeHtml(profile.notesRepoPath) + '</div>' +
              '<div><strong>Generated plan file:</strong> ' + escapeHtml(profile.planFilePath) + '</div>' +
              '<div><strong>Default chat delivery:</strong> user ' + escapeHtml(profile.chatUserId || defaultUserId) + ', channel ' + escapeHtml(profile.chatChannelId || defaultChannelId) + '</div>' +
            '</div>' +
          '</div>' +
          '<details class="assistant-builder-review-card">' +
            '<summary><strong>Advanced Settings</strong></summary>' +
            '<p class="assistant-builder-note" style="margin-top:.75rem">Only change these if your gateway paths, chat defaults, or model providers are not the normal setup.</p>' +
            '<div class="assistant-builder-grid" style="margin-top:.85rem">' +
              assistantInput('Notes Repo Path', 'notesRepoPath', profile.notesRepoPath, { full: true }) +
              assistantInput('Plan File Path', 'planFilePath', profile.planFilePath, { full: true }) +
              assistantInput('Chat User Id', 'chatUserId', profile.chatUserId) +
              assistantInput('Chat Channel Id', 'chatChannelId', profile.chatChannelId) +
              assistantInput('Chat Thread Id', 'chatThreadId', profile.chatThreadId) +
              assistantInput('Chat Thread Title', 'chatThreadTitle', profile.chatThreadTitle) +
              assistantInput('Local Agent Id', 'localAgentId', profile.localAgentId) +
              assistantInput('Local Provider', 'localProviderName', profile.localProviderName) +
              assistantInput('Local Model', 'localModel', profile.localModel) +
              assistantInput('Local Base URL', 'localBaseUrl', profile.localBaseUrl, { full: true }) +
              assistantInput('Expert Agent Id', 'expertAgentId', profile.expertAgentId) +
              assistantInput('Expert Provider', 'expertProviderName', profile.expertProviderName) +
              assistantInput('Expert Model', 'expertModel', profile.expertModel) +
              assistantInput('Expert Base URL', 'expertBaseUrl', profile.expertBaseUrl, { full: true }) +
              assistantInput('Recent Notes Limit', 'recentNotesLimit', String(profile.recentNotesLimit)) +
            '</div>' +
          '</div>' +
          '<div class="assistant-builder-review-card">' +
            '<h3>Cadence</h3>' +
            '<p class="assistant-builder-note">These control recurring coach check-ins. Upcoming events already feed into those check-ins. Dedicated reminder-only workflows are not wired yet.</p>' +
            '<div class="assistant-builder-grid">' +
              assistantInput('Morning Check-In Cron', 'schedules.morningCheckInCron', profile.schedules.morningCheckInCron) +
              assistantInput('Midday Check-In Cron', 'schedules.middayCheckInCron', profile.schedules.middayCheckInCron) +
              assistantInput('Evening Check-In Cron', 'schedules.eveningCheckInCron', profile.schedules.eveningCheckInCron) +
              assistantInput('Weekly Planning Cron', 'schedules.weeklyPlanningCron', profile.schedules.weeklyPlanningCron) +
              assistantInput('Weekly Review Cron', 'schedules.weeklyReviewCron', profile.schedules.weeklyReviewCron) +
              assistantInput('OpenAI API Key', 'expertApiKey', profile.expertApiKey, { full: true }) +
            '</div>' +
          '</div>' +
        '</div>';
        return;
      }

      if (assistantBuilderState.step === 1) {
        body.innerHTML = renderAssistantProjectStep(profile);
        return;
      }

      body.innerHTML = renderAssistantReviewStep(profile);
    }

    function renderAssistantBuilderSummary() {
      const container = document.getElementById('assistantBuilderSummary');
      if (!container || !state.config) {
        return;
      }
      const profile = ensurePersonalAssistantConfig();
      const projects = profile.projects || [];
      const obligations = profile.obligations || [];
      const events = profile.events || [];
      const fitness = profile.fitnessGoals || [];
      const nutrition = profile.nutritionGoals || [];
      const allItems = projects.concat(obligations, events, fitness, nutrition);
      const priorityChips = allItems.slice(0, 8).map(function(item) {
        const label = (item.name || item.title || item.id || 'item') + ' · ' + (item.priority || 'med');
        return '<span class="assistant-builder-chip">' + escapeHtml(label) + '</span>';
      }).join('');
      const datedItemCount = projects.filter(function(item) { return Boolean(item.deadline); }).length
        + obligations.filter(function(item) { return Boolean(item.deadline); }).length
        + events.filter(function(item) { return Boolean(item.startDate); }).length;
      const urgentCount = allItems.filter(function(item) { return item.priority === 'urgent'; }).length;
      container.innerHTML = '' +
        '<div class="assistant-builder-summary-grid">' +
          '<div class="assistant-builder-stat"><strong>' + String(projects.length) + '</strong><span>projects</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(obligations.length) + '</strong><span>obligations</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(events.length) + '</strong><span>events</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(fitness.length + nutrition.length) + '</strong><span>health goals</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(datedItemCount) + '</strong><span>dated</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(urgentCount) + '</strong><span>urgent</span></div>' +
        '</div>' +
        '<div class="assistant-builder-meta">' +
          '<div><strong>Assistant:</strong> ' + escapeHtml(profile.assistantName) + ' (' + escapeHtml(profile.localAgentId) + ')</div>' +
          '<div><strong>GitHub owner:</strong> ' + escapeHtml(profile.githubOwner || 'me') + '</div>' +
          '<div><strong>Plan file:</strong> ' + escapeHtml(profile.planFilePath) + '</div>' +
          '<div><strong>Chat delivery:</strong> ' + escapeHtml(profile.chatChannelId + ' / ' + profile.chatThreadId) + '</div>' +
          '<div><strong>Last applied:</strong> ' + escapeHtml(profile.lastAppliedAt || 'never') + '</div>' +
        '</div>' +
        '<p class="assistant-builder-note" style="margin-top:.85rem">' + escapeHtml(profile.personality || profile.focusStrategy) + '</p>' +
        (priorityChips ? '<div class="assistant-builder-chip-list">' + priorityChips + '</div>' : '');
    }

    function openAssistantBuilderWizard() {
      const wizard = document.getElementById('assistantBuilderWizard');
      if (!wizard) {
        return;
      }
      assistantBuilderState.step = 0;
      renderAssistantBuilderStep();
      wizard.showModal();
    }

    function closeAssistantBuilderWizard() {
      const wizard = document.getElementById('assistantBuilderWizard');
      if (wizard && wizard.open) {
        wizard.close();
      }
    }

    function mutateAssistantField(field, value) {
      const profile = ensurePersonalAssistantConfig();
      const previousAssistantName = profile.assistantName;
      const previousNotesRepoPath = profile.notesRepoPath;
      const previousChatUserId = profile.chatUserId;
      const previousDefaultPlanFilePath = defaultAssistantPlanFilePath(previousNotesRepoPath, previousAssistantName);
      const previousDefaultThreadId = defaultAssistantThreadId(previousAssistantName, previousChatUserId);
      const previousDefaultAgentId = defaultAssistantAgentId(previousAssistantName);
      const previousDefaultThreadTitle = previousAssistantName;
      if (field.startsWith('schedules.')) {
        profile.schedules[field.slice('schedules.'.length)] = value;
      } else if (field === 'enabled') {
        profile.enabled = value === true || value === 'true';
      } else if (field === 'recentNotesLimit') {
        profile.recentNotesLimit = value ? Number(value) : 10;
      } else {
        profile[field] = value;
      }
      if ((field === 'assistantName' || field === 'notesRepoPath') && profile.planFilePath === previousDefaultPlanFilePath) {
        profile.planFilePath = defaultAssistantPlanFilePath(profile.notesRepoPath, profile.assistantName);
      }
      if ((field === 'assistantName' || field === 'chatUserId') && profile.chatThreadId === previousDefaultThreadId) {
        profile.chatThreadId = defaultAssistantThreadId(profile.assistantName, profile.chatUserId);
      }
      if (field === 'assistantName' && profile.localAgentId === previousDefaultAgentId) {
        profile.localAgentId = defaultAssistantAgentId(profile.assistantName);
      }
      if (field === 'assistantName' && profile.chatThreadTitle === previousDefaultThreadTitle) {
        profile.chatThreadTitle = profile.assistantName;
      }
      applyAssistantProfileDefaults(profile);
    }

    function updateAssistantInput(target) {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
        return;
      }

      if (target instanceof HTMLInputElement && target.dataset.assistantUpload === 'project-plan') {
        void handleAssistantProjectPlanUpload(target);
        return;
      }

      const arrayField = target.dataset.assistantArrayField;
      const topLevelField = target.dataset.assistantField;
      const section = target.dataset.assistantSection;
      const indexText = target.dataset.assistantIndex;
      const itemField = target.dataset.assistantField;

      if (arrayField) {
        const profile = ensurePersonalAssistantConfig();
        profile[arrayField] = target.value.split('\\n').map(function(item) { return item.trim(); }).filter(Boolean);
        syncRawJson();
        renderAssistantBuilderSummary();
        return;
      }

      if (section && indexText !== undefined && itemField) {
        const profile = ensurePersonalAssistantConfig();
        const index = Number(indexText);
        if (!Number.isFinite(index) || !Array.isArray(profile[section]) || !profile[section][index]) {
          return;
        }
        let nextValue = target.value;
        if (itemField === 'priority') {
          const normalized = String(nextValue || '').toLowerCase();
          if (normalized === 'critical') {
            nextValue = 'urgent';
          } else if (normalized === 'medium') {
            nextValue = 'med';
          }
        }
        if (itemField === 'repoSlug') {
          const ownerPrefix = String((profile.githubOwner || '') + '/').toLowerCase();
          const trimmed = String(nextValue || '').trim()
            .replace('https://github.com/', '')
            .replace('http://github.com/', '');
          nextValue = trimmed.toLowerCase().startsWith(ownerPrefix)
            ? trimmed.slice(ownerPrefix.length)
            : trimmed;
        }
        profile[section][index][itemField] = nextValue;
        syncRawJson();
        renderAssistantBuilderSummary();
        return;
      }

      if (topLevelField) {
        mutateAssistantField(topLevelField, target.value);
        syncRawJson();
        renderAssistantBuilderSummary();
      }
    }

    async function handleAssistantProjectPlanUpload(input) {
      const section = input.dataset.assistantSection;
      const index = Number(input.dataset.assistantIndex || '-1');
      const profile = ensurePersonalAssistantConfig();
      if (section !== 'projects' || !Number.isFinite(index) || !Array.isArray(profile.projects) || !profile.projects[index]) {
        return;
      }

      const file = input.files && input.files[0];
      if (!file) {
        return;
      }

      try {
        let content = await file.text();
        let truncated = false;
        if (content.length > MAX_UPLOADED_PROJECT_PLAN_CHARS) {
          content = content.slice(0, MAX_UPLOADED_PROJECT_PLAN_CHARS) + '\\n...(truncated)...';
          truncated = true;
        }

        const project = profile.projects[index];
        project.planContent = content;
        if (!project.planFilePath || !project.planFilePath.trim()) {
          project.planFilePath = file.name;
        }

        syncRawJson();
        renderAssistantBuilderSummary();
        renderAssistantBuilderStep();
        setStatus(
          truncated
            ? 'Uploaded ' + file.name + ' (truncated to ' + String(MAX_UPLOADED_PROJECT_PLAN_CHARS) + ' characters)'
            : 'Uploaded ' + file.name + ' for ' + (project.name || project.id),
        );
      } catch (error) {
        setStatus('Failed to read uploaded plan file: ' + describeClientError(error), 'error');
      } finally {
        input.value = '';
      }
    }

    function handleAssistantBuilderAction(button) {
      const action = button.dataset.assistantAction;
      if (!action) {
        return;
      }
      const profile = ensurePersonalAssistantConfig();
      if (action === 'add-item') {
        if (button.dataset.assistantSection === 'projects') {
          profile.projects.push(createAssistantProject());
        } else if (button.dataset.assistantSection === 'obligations') {
          profile.obligations.push(createAssistantObligation());
        } else if (button.dataset.assistantSection === 'fitnessGoals') {
          profile.fitnessGoals.push(createAssistantGoal('fitnessGoals'));
        } else if (button.dataset.assistantSection === 'nutritionGoals') {
          profile.nutritionGoals.push(createAssistantGoal('nutritionGoals'));
        } else if (button.dataset.assistantSection === 'events') {
          profile.events.push(createAssistantEvent());
        }
        syncRawJson();
        renderAssistantBuilderSummary();
        renderAssistantBuilderStep();
        return;
      }
      if (action === 'remove-item') {
        const section = button.dataset.assistantSection;
        const index = Number(button.dataset.assistantIndex || '-1');
        if (section && Array.isArray(profile[section]) && index >= 0) {
          profile[section].splice(index, 1);
          syncRawJson();
          renderAssistantBuilderSummary();
          renderAssistantBuilderStep();
        }
        return;
      }
      if (action === 'clear-project-plan') {
        const index = Number(button.dataset.assistantIndex || '-1');
        if (index >= 0 && profile.projects[index]) {
          profile.projects[index].planContent = '';
          syncRawJson();
          renderAssistantBuilderSummary();
          renderAssistantBuilderStep();
          setStatus('Cleared uploaded plan for ' + (profile.projects[index].name || profile.projects[index].id));
        }
      }
    }

    let applyAssistantInFlight = false;

    function setAssistantApplyButtonsBusy(busy) {
      const buttonIds = ['applyAssistantBuilderButton', 'assistantBuilderApplyButton'];
      buttonIds.forEach(function(id) {
        const button = document.getElementById(id);
        if (!button) {
          return;
        }
        if (busy) {
          if (!button.dataset.originalLabel) {
            button.dataset.originalLabel = button.textContent || '';
          }
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          button.textContent = 'Applying\u2026';
        } else {
          if (button.dataset.originalLabel) {
            button.textContent = button.dataset.originalLabel;
            delete button.dataset.originalLabel;
          }
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
      });
    }

    async function applyAssistantBuilderSetup() {
      if (applyAssistantInFlight) {
        return;
      }
      applyAssistantInFlight = true;
      setAssistantApplyButtonsBusy(true);
      setStatus('Applying coach setup\u2026');
      try {
        await persistConfigState({ renderAfterSave: false });
        const result = await requestJson('POST', '/api/personal-assistant/apply');
        state.config = result.config;
        await Promise.all([
          fetchWorkflows().catch(function() { return null; }),
          fetchProjectTrackingOverview().catch(function() { return null; }),
          fetchChatProviders().catch(function() { return null; })
        ]);
        render();
        setStatus(result.message || 'Applied assistant builder setup');
        closeAssistantBuilderWizard();
      } finally {
        applyAssistantInFlight = false;
        setAssistantApplyButtonsBusy(false);
      }
    }

`;
