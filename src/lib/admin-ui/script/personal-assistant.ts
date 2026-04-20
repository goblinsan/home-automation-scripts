/**
 * Admin UI — personal assistant builder browser-runtime module.
 */

export const PERSONAL_ASSISTANT_SCRIPT = `    const assistantBuilderState = { step: 0 };
    const assistantBuilderSteps = [
      { title: 'Basics', description: 'Who this assistant helps, where notes live, and where chat check-ins should land.' },
      { title: 'Projects', description: 'Current and future work the coach should track and push forward.' },
      { title: 'Commitments', description: 'Obligations, trips, events, and important dates that compete for attention.' },
      { title: 'Health Goals', description: 'Workout and nutrition goals the assistant should keep in view.' },
      { title: 'Review', description: 'Preview the generated plan, managed agents, and recurring workflows before applying.' }
    ];

    function assistantSlugify(value, fallback) {
      const normalized = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || fallback;
    }

    function ensurePersonalAssistantConfig() {
      if (!state.config.personalAssistant) {
        state.config.personalAssistant = {
          enabled: false,
          ownerName: 'Jim',
          assistantName: 'Personal Assistant',
          timezone: 'America/New_York',
          notesRepoPath: '/srv/notes',
          planFilePath: '/srv/notes/projects/personal-assistant-plan.md',
          notesSearchDirs: ['daily', 'projects', 'inbox'],
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
      return state.config.personalAssistant;
    }

    function createAssistantProject() {
      const profile = ensurePersonalAssistantConfig();
      const index = profile.projects.length + 1;
      return {
        id: 'project-' + index,
        name: 'New Project ' + index,
        status: 'on-track',
        priority: 'high',
        summary: 'Define the actual outcome this project needs to reach.',
        nextAction: 'Write the next concrete step.',
        deadline: '',
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
        priority: 'medium',
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
        priority: 'medium',
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
        priority: 'medium',
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
          return [
            '- ' + project.name + ' [' + project.status + ', ' + project.priority + ']',
            '  Summary: ' + project.summary,
            '  Next: ' + project.nextAction,
            project.deadline ? '  Deadline: ' + project.deadline : '',
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
      return '<div class="assistant-builder-list">' +
        (profile.projects.length === 0
          ? '<div class="assistant-builder-note">No projects yet. Add current work and future work you want the coach to track.</div>'
          : profile.projects.map(function(project, index) {
              return '<div class="assistant-builder-item">' +
                '<div class="assistant-builder-item-header">' +
                  '<strong>' + escapeHtml(project.name || project.id) + '</strong>' +
                  '<button type="button" class="danger" data-assistant-action="remove-item" data-assistant-section="projects" data-assistant-index="' + String(index) + '">Remove</button>' +
                '</div>' +
                '<div class="assistant-builder-grid">' +
                  assistantItemField('projects', index, 'Project Id', 'id', project.id) +
                  assistantItemField('projects', index, 'Name', 'name', project.name) +
                  assistantItemSelect('projects', index, 'Status', 'status', project.status, ['idea', 'on-track', 'at-risk', 'blocked', 'done']) +
                  assistantItemSelect('projects', index, 'Priority', 'priority', project.priority, ['critical', 'high', 'medium', 'low']) +
                  assistantItemField('projects', index, 'Deadline', 'deadline', project.deadline || '') +
                  assistantItemField('projects', index, 'Next Action', 'nextAction', project.nextAction) +
                  assistantItemTextarea('projects', index, 'Summary', 'summary', project.summary, { full: true, rows: 3 }) +
                  assistantItemTextarea('projects', index, 'Notes', 'notes', project.notes || '', { full: true, rows: 3 }) +
                '</div>' +
              '</div>';
            }).join('')) +
        '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="projects">Add Project</button></div>' +
      '</div>';
    }

    function renderAssistantCommitmentStep(profile) {
      return '<div class="assistant-builder-review">' +
        '<div class="assistant-builder-review-card">' +
          '<h3>Obligations</h3>' +
          '<div class="assistant-builder-list">' +
            (profile.obligations.length === 0
              ? '<div class="assistant-builder-note">Add recurring responsibilities like coaching soccer, family commitments, bills, or deadlines.</div>'
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
                      assistantItemSelect('obligations', index, 'Priority', 'priority', item.priority, ['critical', 'high', 'medium', 'low']) +
                      assistantItemField('obligations', index, 'Deadline', 'deadline', item.deadline || '') +
                      assistantItemField('obligations', index, 'Schedule', 'schedule', item.schedule || '') +
                      assistantItemTextarea('obligations', index, 'Notes', 'notes', item.notes || '', { full: true, rows: 3 }) +
                    '</div>' +
                  '</div>';
                }).join('')) +
            '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="obligations">Add Obligation</button></div>' +
          '</div>' +
        '</div>' +
        '<div class="assistant-builder-review-card">' +
          '<h3>Trips, Events, And Important Dates</h3>' +
          '<div class="assistant-builder-list">' +
            (profile.events.length === 0
              ? '<div class="assistant-builder-note">Add travel, appointments, launches, games, or any date that should shape the week.</div>'
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
                      assistantItemSelect('events', index, 'Priority', 'priority', item.priority, ['high', 'medium', 'low']) +
                      assistantItemTextarea('events', index, 'Notes', 'notes', item.notes || '', { full: true, rows: 3 }) +
                    '</div>' +
                  '</div>';
                }).join('')) +
            '<div class="toolbar"><button type="button" data-assistant-action="add-item" data-assistant-section="events">Add Event Or Date</button></div>' +
          '</div>' +
        '</div>' +
      '</div>';
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
                    assistantItemSelect(section, index, 'Priority', 'priority', item.priority, ['high', 'medium', 'low']) +
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
            '<div><strong>Chat thread:</strong> ' + escapeHtml(profile.chatChannelId + ' / ' + profile.chatThreadId) + '</div>' +
            '<div><strong>Managed agents:</strong> ' + escapeHtml(generatedAgents.join(', ')) + '</div>' +
            '<div><strong>Managed workflows:</strong> ' + escapeHtml(generatedWorkflows.join(', ')) + '</div>' +
            '<div><strong>Last applied:</strong> ' + escapeHtml(profile.lastAppliedAt || 'never') + '</div>' +
          '</div>' +
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
        body.innerHTML = '<div class="assistant-builder-review">' +
          '<div class="assistant-builder-review-card">' +
            '<h3>Assistant Basics</h3>' +
            '<div class="assistant-builder-grid">' +
              '<label class="wizard-field"><span class="wizard-label">Enabled</span><select data-assistant-field="enabled">' + assistantOptionList([{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }], String(profile.enabled)) + '</select></label>' +
              assistantInput('Owner Name', 'ownerName', profile.ownerName) +
              assistantInput('Assistant Name', 'assistantName', profile.assistantName) +
              assistantInput('Time Zone', 'timezone', profile.timezone) +
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
              assistantTextarea('Notes Search Dirs (one per line)', 'notesSearchDirs', assistantArrayText(profile.notesSearchDirs), { full: true, rows: 3, arrayField: true }) +
              assistantTextarea('Focus Strategy', 'focusStrategy', profile.focusStrategy, { full: true, rows: 4 }) +
              assistantTextarea('Weekly Outcome', 'weeklyOutcome', profile.weeklyOutcome, { full: true, rows: 4 }) +
              assistantTextarea('Priority Stack (one per line)', 'priorities', assistantArrayText(profile.priorities), { full: true, rows: 4, arrayField: true }) +
              assistantTextarea('Weekly Themes (one per line)', 'weeklyThemes', assistantArrayText(profile.weeklyThemes), { full: true, rows: 4, arrayField: true }) +
            '</div>' +
          '</div>' +
          '<div class="assistant-builder-review-card">' +
            '<h3>Cadence</h3>' +
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

      if (assistantBuilderState.step === 2) {
        body.innerHTML = renderAssistantCommitmentStep(profile);
        return;
      }

      if (assistantBuilderState.step === 3) {
        body.innerHTML = renderAssistantHealthStep(profile);
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
      const priorityChips = profile.priorities.slice(0, 6).map(function(item) {
        return '<span class="assistant-builder-chip">' + escapeHtml(item) + '</span>';
      }).join('');
      container.innerHTML = '' +
        '<div class="assistant-builder-summary-grid">' +
          '<div class="assistant-builder-stat"><strong>' + String(profile.projects.length) + '</strong><span>projects</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(profile.obligations.length) + '</strong><span>obligations</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(profile.fitnessGoals.length + profile.nutritionGoals.length) + '</strong><span>health goals</span></div>' +
          '<div class="assistant-builder-stat"><strong>' + String(profile.events.length) + '</strong><span>events and dates</span></div>' +
        '</div>' +
        '<div class="assistant-builder-meta">' +
          '<div><strong>Assistant:</strong> ' + escapeHtml(profile.assistantName) + ' (' + escapeHtml(profile.localAgentId) + ')</div>' +
          '<div><strong>Plan file:</strong> ' + escapeHtml(profile.planFilePath) + '</div>' +
          '<div><strong>Chat delivery:</strong> ' + escapeHtml(profile.chatChannelId + ' / ' + profile.chatThreadId) + '</div>' +
          '<div><strong>Last applied:</strong> ' + escapeHtml(profile.lastAppliedAt || 'never') + '</div>' +
        '</div>' +
        '<p class="assistant-builder-note" style="margin-top:.85rem">' + escapeHtml(profile.focusStrategy) + '</p>' +
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
      if (field.startsWith('schedules.')) {
        profile.schedules[field.slice('schedules.'.length)] = value;
      } else if (field === 'enabled') {
        profile.enabled = value === true || value === 'true';
      } else if (field === 'recentNotesLimit') {
        profile.recentNotesLimit = value ? Number(value) : 10;
      } else {
        profile[field] = value;
      }
    }

    function updateAssistantInput(target) {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
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
        profile[section][index][itemField] = target.value;
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
      }
    }

    async function applyAssistantBuilderSetup() {
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
    }

`;
