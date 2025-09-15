/**
 * Booking Status Utility
 * ======================
 *
 * Calculates booking status based on check-in/check-out dates and current time
 */

export type BookingStatus = 'upcoming' | 'current' | 'completed' | 'canceled';

/**
 * Calculate booking status based on dates
 */
export function calculateBookingStatus(
  checkInDate: Date | null,
  checkOutDate: Date | null,
  isCanceled: boolean = false
): BookingStatus {
  // If explicitly canceled, return canceled
  if (isCanceled) {
    return 'canceled';
  }

  // If we don't have both dates, default to upcoming
  if (!checkInDate || !checkOutDate) {
    return 'upcoming';
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // Today at 00:00
  const checkIn = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate());
  const checkOut = new Date(checkOutDate.getFullYear(), checkOutDate.getMonth(), checkOutDate.getDate());

  // If check-out has passed, it's completed
  if (checkOut < today) {
    return 'completed';
  }

  // If check-in has passed but check-out hasn't, it's current
  if (checkIn <= today && checkOut >= today) {
    return 'current';
  }

  // If check-in is in the future, it's upcoming
  return 'upcoming';
}

/**
 * Update booking status from email type and dates
 */
export function determineStatusFromEmail(
  emailType: string | undefined,
  checkInDate: Date | null,
  checkOutDate: Date | null,
  currentStatus?: string
): BookingStatus {
  // Check for cancellation first
  const isCanceled = emailType === 'cancellation' ||
                    currentStatus === 'canceled' ||
                    currentStatus === 'cancelled';

  return calculateBookingStatus(checkInDate, checkOutDate, isCanceled);
}