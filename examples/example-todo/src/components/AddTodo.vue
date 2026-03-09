<script setup lang="ts">
import { useOperation } from "@sqstore/vue";
import { inject, ref } from "vue";
import type { TodoStore } from "../store";

const store = inject<TodoStore>("store")!;

const title = ref("");
const { execute: addTodo, isLoading } = useOperation(store, "addTodo");

function onSubmit() {
  const value = title.value.trim();
  if (!value) return;
  addTodo({ title: value });
  title.value = "";
}
</script>

<template>
  <form class="add-form" @submit.prevent="onSubmit">
    <input
      v-model="title"
      placeholder="What needs to be done?"
      :disabled="isLoading"
    />
    <button type="submit" :disabled="isLoading || !title.trim()">
      <span v-if="isLoading" class="spinner"></span>
      <span v-else>Add</span>
    </button>
  </form>
</template>
