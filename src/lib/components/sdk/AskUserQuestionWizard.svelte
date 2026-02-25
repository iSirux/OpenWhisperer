<script lang="ts">
  import type { PlanningQuestion, PlanningAnswer } from '$lib/stores/sdkSessions';

  let {
    questions,
    answers,
    currentQuestionIndex,
    onAnswerChange,
    onNavigate,
    onSubmit,
    onDismiss,
  }: {
    questions: PlanningQuestion[];
    answers: PlanningAnswer[];
    currentQuestionIndex: number;
    onAnswerChange: (answer: PlanningAnswer) => void;
    onNavigate: (index: number) => void;
    onSubmit: () => void;
    onDismiss: () => void;
  } = $props();

  // Current question
  let currentQuestion = $derived(questions[currentQuestionIndex]);

  // Get existing answer for current question
  let currentAnswer = $derived(
    answers.find(a => a.questionIndex === currentQuestionIndex) || {
      questionIndex: currentQuestionIndex,
      selectedOptions: [],
      textInput: '',
    }
  );

  // Text input for custom "Other" response
  let textInput = $state('');

  // Sync text input when question changes
  $effect(() => {
    textInput = currentAnswer.textInput || '';
  });

  function toggleOption(optionIndex: number) {
    const current = currentAnswer.selectedOptions;
    let newSelected: number[];

    if (currentQuestion.multiSelect) {
      if (current.includes(optionIndex)) {
        newSelected = current.filter(i => i !== optionIndex);
      } else {
        newSelected = [...current, optionIndex];
      }
    } else {
      newSelected = current.includes(optionIndex) ? [] : [optionIndex];
    }

    onAnswerChange({
      questionIndex: currentQuestionIndex,
      selectedOptions: newSelected,
      textInput: textInput || undefined,
    });
  }

  function handleTextInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    textInput = target.value;
    onAnswerChange({
      questionIndex: currentQuestionIndex,
      selectedOptions: currentAnswer.selectedOptions,
      textInput: target.value || undefined,
    });
  }

  function handlePrevious() {
    if (currentQuestionIndex > 0) {
      onNavigate(currentQuestionIndex - 1);
    }
  }

  function handleNext() {
    if (currentQuestionIndex < questions.length - 1) {
      onNavigate(currentQuestionIndex + 1);
    }
  }

  // Check if all questions have at least one answer
  let allAnswered = $derived(
    questions.every((_, index) =>
      answers.some(a => a.questionIndex === index && (a.selectedOptions.length > 0 || a.textInput))
    )
  );

  // Keyboard navigation
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' && currentQuestionIndex > 0) {
      event.preventDefault();
      handlePrevious();
    } else if (event.key === 'ArrowRight' && currentQuestionIndex < questions.length - 1) {
      event.preventDefault();
      handleNext();
    } else if (event.key === 'Enter' && event.ctrlKey && allAnswered) {
      event.preventDefault();
      onSubmit();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="ask-user-wizard">
  <!-- Header -->
  <div class="wizard-header">
    <svg class="header-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <span class="header-title">Claude has a question</span>
    <button class="dismiss-btn" onclick={onDismiss} title="Dismiss questions">
      <svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
      </svg>
    </button>
  </div>

  {#if questions.length === 0}
    <div class="waiting">
      <div class="animate-pulse">Waiting for questions...</div>
    </div>
  {:else if currentQuestion}
    <!-- Navigation chips (only show if multiple questions) -->
    {#if questions.length > 1}
      <div class="nav-chips">
        {#each questions as question, index}
          {@const isAnswered = answers.some(a => a.questionIndex === index && (a.selectedOptions.length > 0 || a.textInput))}
          {@const isCurrent = index === currentQuestionIndex}
          <button
            class="chip"
            class:chip-current={isCurrent}
            class:chip-answered={isAnswered && !isCurrent}
            onclick={() => onNavigate(index)}
          >
            {question.header}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Current question -->
    <div class="question-section">
      <p class="question-text">{currentQuestion.question}</p>

      <!-- Options -->
      <div class="options">
        {#each currentQuestion.options as option, optionIndex}
          {@const isSelected = currentAnswer.selectedOptions.includes(optionIndex)}
          <button
            class="option"
            class:option-selected={isSelected}
            onclick={() => toggleOption(optionIndex)}
          >
            <div class="checkbox" class:checkbox-selected={isSelected}>
              {#if isSelected}
                <svg fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              {/if}
            </div>
            <div class="option-content">
              <span class="option-label">{option.label}</span>
              <span class="option-desc">{option.description}</span>
            </div>
          </button>
        {/each}
      </div>

      <!-- "Other" custom text input -->
      <textarea
        class="other-input"
        placeholder="Other (custom answer)"
        rows="1"
        value={textInput}
        oninput={handleTextInput}
      ></textarea>
    </div>

    <!-- Navigation footer -->
    <div class="nav-footer">
      {#if questions.length > 1}
        <button
          class="nav-btn"
          disabled={currentQuestionIndex === 0}
          onclick={handlePrevious}
        >
          Prev
        </button>

        <span class="nav-counter">
          {currentQuestionIndex + 1}/{questions.length}
        </span>
      {:else}
        <div></div>
        <div></div>
      {/if}

      {#if currentQuestionIndex < questions.length - 1}
        <button class="nav-btn nav-btn-next" onclick={handleNext}>
          Next
        </button>
      {:else}
        <button
          class="submit-btn"
          disabled={!allAnswered}
          onclick={onSubmit}
          title={allAnswered ? 'Submit answers (Ctrl+Enter)' : 'Please answer all questions'}
        >
          Submit
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ask-user-wizard {
    padding: 0.75rem;
    background: var(--color-surface-elevated);
    border-radius: 0.5rem;
    border: 1px solid var(--color-accent);
    border-left: 3px solid var(--color-accent);
    font-size: 0.8125rem;
  }

  /* Header */
  .wizard-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.5rem;
    color: var(--color-accent);
  }

  .header-icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .header-title {
    font-weight: 600;
    font-size: 0.75rem;
    flex: 1;
  }

  .dismiss-btn {
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    border-radius: 0.25rem;
    transition: all 0.15s;
  }

  .dismiss-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-border);
  }

  .dismiss-btn svg {
    width: 0.875rem;
    height: 0.875rem;
  }

  /* Waiting state */
  .waiting {
    text-align: center;
    padding: 1rem;
    color: var(--color-text-muted);
  }

  /* Navigation chips */
  .nav-chips {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
    overflow-x: auto;
    padding-bottom: 0.25rem;
  }

  .chip {
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    border-radius: 1rem;
    white-space: nowrap;
    transition: all 0.15s;
    background: var(--color-border);
    color: var(--color-text-muted);
  }

  .chip-current {
    background: var(--color-accent);
    color: white;
  }

  .chip-answered {
    background: color-mix(in srgb, var(--color-accent) 20%, transparent);
    color: var(--color-accent);
  }

  /* Question section */
  .question-section {
    margin-bottom: 0.5rem;
  }

  .question-text {
    font-size: 0.8125rem;
    color: var(--color-text-primary);
    font-weight: 500;
    margin-bottom: 0.5rem;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .option {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem;
    text-align: left;
    border-radius: 0.375rem;
    border: 1px solid var(--color-border);
    transition: all 0.15s;
  }

  .option:hover {
    border-color: var(--color-accent);
  }

  .option-selected {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .checkbox {
    width: 0.875rem;
    height: 0.875rem;
    margin-top: 0.0625rem;
    border-radius: 0.1875rem;
    border: 1px solid var(--color-text-muted);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .checkbox-selected {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: white;
  }

  .checkbox svg {
    width: 0.625rem;
    height: 0.625rem;
  }

  .option-content {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
  }

  .option-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .option-desc {
    font-size: 0.6875rem;
    color: var(--color-text-secondary);
  }

  .other-input {
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    resize: none;
    color: var(--color-text-primary);
    transition: border-color 0.15s;
  }

  .other-input:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  .other-input::placeholder {
    color: var(--color-text-muted);
  }

  /* Navigation footer */
  .nav-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .nav-btn {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    transition: color 0.15s;
  }

  .nav-btn:hover:not(:disabled) {
    color: var(--color-text-primary);
  }

  .nav-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .nav-btn-next {
    color: var(--color-accent);
  }

  .nav-btn-next:hover {
    opacity: 0.8;
  }

  .nav-counter {
    font-size: 0.6875rem;
    color: var(--color-text-muted);
  }

  .submit-btn {
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    background: var(--color-accent);
    color: white;
    border-radius: 0.25rem;
    transition: opacity 0.15s;
  }

  .submit-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .submit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
