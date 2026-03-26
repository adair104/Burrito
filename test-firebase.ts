import { initializeApp, getApps, getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
console.log(typeof initializeApp, typeof getApps, typeof getApp, typeof getFirestore, typeof FieldValue);
